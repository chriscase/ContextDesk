import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_ERROR_SCHEMA_ID,
  CASE_LIST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  parseCaseList,
  parseInvestigationCollectionPage,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationOperationsQueuePage,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { MemoryLocalGrantStore } from "../people/index.js";
import { MemoryInvestigationCollectionGraph } from "./collection-graph.js";
import { CaseService } from "./service.js";
import { MemoryCaseStore } from "./store.js";

const ALICE = "fixture-alice-secret";
const IMPACT = {
  productName: "Fixture Desk",
  version: "4.2",
  build: "",
  component: "queue-worker",
  environment: "",
};

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
      "eve",
      {
        password: "fixture-eve-secret",
        identity: {
          id: "uid=eve,ou=people,dc=example,dc=test",
          username: "eve",
          displayName: "eve",
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
  ]);
}

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

class CountingListCaseStore extends MemoryCaseStore {
  listCalls = 0;
  coordinationSnapshotCalls = 0;
  coordinationLookupCalls = 0;

  override async listCases(): Promise<Awaited<ReturnType<MemoryCaseStore["listCases"]>>> {
    this.listCalls += 1;
    return super.listCases();
  }

  override async listCaseCoordinationSnapshot(
    scope: Parameters<MemoryCaseStore["listCaseCoordinationSnapshot"]>[0],
  ): ReturnType<MemoryCaseStore["listCaseCoordinationSnapshot"]> {
    this.coordinationSnapshotCalls += 1;
    return super.listCaseCoordinationSnapshot(scope);
  }

  override async getInvestigationCoordination(
    caseId: string,
  ): ReturnType<MemoryCaseStore["getInvestigationCoordination"]> {
    this.coordinationLookupCalls += 1;
    return super.getInvestigationCoordination(caseId);
  }
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    domain: CaseService;
    caseStore: CountingListCaseStore;
    graph: MemoryInvestigationCollectionGraph;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-collection-http-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const caseStore = new CountingListCaseStore();
  const graph = new MemoryInvestigationCollectionGraph();
  const domain = new CaseService(store, audit, caseStore, catalog);
  domain.bindCollectionGraph(graph);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    grants: new MemoryLocalGrantStore(),
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
    await fn({ app, domain, caseStore, graph });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
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

function collectionUrl(params: Record<string, string | string[]> = {}): string {
  const search = new URLSearchParams();
  search.set("schemaId", INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, value);
    }
  }
  return `/api/cases?${search.toString()}`;
}

function operationsQueueUrl(params: Record<string, string | string[]> = {}): string {
  const search = new URLSearchParams();
  search.set("schemaId", INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, value);
    }
  }
  return `/api/cases?${search.toString()}`;
}

async function createCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{
  id: string;
  title: string;
  status: string;
  participants: Array<{ identityId: string; username: string }>;
}> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: session },
    payload: { title, ...extra },
  });
  expect(created.statusCode).toBe(200);
  return JSON.parse(created.body) as {
    id: string;
    title: string;
    status: string;
    participants: Array<{ identityId: string; username: string }>;
  };
}

describe("GET /api/cases collection query", () => {
  it("preserves the legacy unpaged list when no collection query is supplied", async () => {
    await withApp(async ({ app, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await createCase(app, alice, "Legacy list fixture");
      await caseStore.updateCaseMeta({ id: created.id, status: "archived" });
      const queueBefore = caseStore.coordinationSnapshotCalls;

      const unauthenticated = await app.inject({ method: "GET", url: "/api/cases" });
      expect(unauthenticated.statusCode).toBe(401);
      expect(JSON.parse(unauthenticated.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "unauthenticated",
      });
      const unauthenticatedQueue = await app.inject({
        method: "GET",
        url: operationsQueueUrl(),
      });
      expect(unauthenticatedQueue.statusCode).toBe(401);
      expect(caseStore.coordinationSnapshotCalls).toBe(queueBefore);

      const listed = await app.inject({
        method: "GET",
        url: "/api/cases",
        headers: { cookie: alice },
      });
      expect(listed.statusCode).toBe(200);
      const body = parseCaseList(JSON.parse(listed.body));
      expect(body.schemaId).toBe(CASE_LIST_SCHEMA_ID);
      expect(body.cases.map((item) => item.id)).toContain(created.id);
      expect(body.cases.find((item) => item.id === created.id)?.status).toBe("archived");
    });
  });

  it("returns a versioned filtered page when schemaId selects the collection query", async () => {
    await withApp(async ({ app, graph }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await createCase(app, alice, "Synthetic checkout investigation", {
        affectedParties: "Fixture storefront operators",
      });
      graph.linkEntity(created.id, "ent-northwind", "Northwind");
      graph.recordImpact(created.id, IMPACT);

      const response = await app.inject({
        method: "GET",
        url: collectionUrl({
          q: "storefront",
          status: "open",
          entityId: "ent-northwind",
          impactIdentity: JSON.stringify(IMPACT),
          limit: "10",
        }),
        headers: { cookie: alice },
      });
      expect(response.statusCode).toBe(200);
      const page = parseInvestigationCollectionPage(JSON.parse(response.body));
      expect(page.schemaId).toBe(INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID);
      expect(page.items.map((item) => item.id)).toEqual([created.id]);
      expect(page.facets.entity.top).toEqual([{ key: "ent-northwind", count: 1 }]);
      expect(page.facets.impactIdentity.top[0]?.identity).toEqual(IMPACT);
      expect(page).not.toHaveProperty("rank");
    });
  });

  it("selects the queue schema exactly and derives member/admin scopes and counts", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const eve = await login(app, "eve", "fixture-eve-secret");
      const dave = await login(app, "dave", "fixture-dave-secret");
      const aliceCase = await createCase(app, alice, "Alice queue fixture");
      const eveCase = await createCase(app, eve, "Eve private queue fixture");
      const claim = await app.inject({
        method: "POST",
        url: `/api/cases/${aliceCase.id}/coordination`,
        headers: { cookie: alice },
        payload: {
          schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
          investigationId: aliceCase.id,
          action: "claim_self",
          expectedRevision: 0,
          idempotencyKey: "queue-http-claim-alice",
        },
      });
      expect(claim.statusCode).toBe(200);
      const aliceIdentity = parseInvestigationCoordinationActionSuccess(
        JSON.parse(claim.body),
      ).applied.coordinator!;

      const mineResponse = await app.inject({
        method: "GET",
        url: operationsQueueUrl({ coordinationScope: "mine" }),
        headers: { cookie: alice },
      });
      expect(mineResponse.statusCode).toBe(200);
      const mine = parseInvestigationOperationsQueuePage(JSON.parse(mineResponse.body));
      expect(mine.schemaId).toBe(INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID);
      expect(mine.items.map((item) => item.investigation.id)).toEqual([aliceCase.id]);
      expect(mine.items[0]?.coordination.coordinator?.identityId).toBe(
        aliceIdentity.identityId,
      );
      expect(mine.coordinationScopeCounts).toEqual({ allVisible: 1, mine: 1, unassigned: 0 });
      expect(JSON.stringify(mine)).not.toContain(eveCase.id);

      const unassigned = parseInvestigationOperationsQueuePage(JSON.parse((await app.inject({
        method: "GET",
        url: operationsQueueUrl({ coordinationScope: "unassigned" }),
        headers: { cookie: alice },
      })).body));
      expect(unassigned.items).toEqual([]);
      expect(unassigned.coordinationScopeCounts).toEqual(mine.coordinationScopeCounts);

      const admin = parseInvestigationOperationsQueuePage(JSON.parse((await app.inject({
        method: "GET",
        url: operationsQueueUrl(),
        headers: { cookie: dave },
      })).body));
      expect(admin.items.map((item) => item.investigation.id).sort()).toEqual(
        [aliceCase.id, eveCase.id].sort(),
      );
      expect(admin.coordinationScopeCounts).toEqual({ allVisible: 2, mine: 0, unassigned: 1 });
    });
  });

  it("rejects queue cursor tampering and cross-scope or cross-schema replay", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      await createCase(app, alice, "Queue cursor one");
      await createCase(app, alice, "Queue cursor two");
      const first = parseInvestigationOperationsQueuePage(JSON.parse((await app.inject({
        method: "GET",
        url: operationsQueueUrl({ limit: "1" }),
        headers: { cookie: alice },
      })).body));
      expect(first.nextCursor).toEqual(expect.any(String));
      const cursor = first.nextCursor ?? "";
      const second = await app.inject({
        method: "GET",
        url: operationsQueueUrl({ limit: "1", cursor }),
        headers: { cookie: alice },
      });
      expect(second.statusCode).toBe(200);
      expect(parseInvestigationOperationsQueuePage(JSON.parse(second.body)).items).toHaveLength(1);

      const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
      const tampered = await app.inject({
        method: "GET",
        url: operationsQueueUrl({ limit: "1", cursor: tamperedCursor }),
        headers: { cookie: alice },
      });
      expect(tampered.statusCode).toBe(400);
      expect(JSON.parse(tampered.body)).toEqual({ error: "malformed_cursor" });

      const wrongScope = await app.inject({
        method: "GET",
        url: operationsQueueUrl({ limit: "1", coordinationScope: "unassigned", cursor }),
        headers: { cookie: alice },
      });
      expect(wrongScope.statusCode).toBe(400);
      expect(JSON.parse(wrongScope.body)).toEqual({ error: "stale_cursor" });

      const wrongSchema = await app.inject({
        method: "GET",
        url: collectionUrl({ limit: "1", cursor }),
        headers: { cookie: alice },
      });
      expect(wrongSchema.statusCode).toBe(400);
      expect(JSON.parse(wrongSchema.body)).toEqual({ error: "malformed_cursor" });
    });
  });

  it("keeps empty and filtered-empty pages distinct and reports hidden archived matches", async () => {
    await withApp(async ({ app, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const emptyResponse = await app.inject({
        method: "GET",
        url: collectionUrl({ q: "checkout" }),
        headers: { cookie: alice },
      });
      const empty = parseInvestigationCollectionPage(JSON.parse(emptyResponse.body));
      expect(empty.items).toEqual([]);
      expect(empty.facets.contributor.top).toEqual([]);

      const live = await createCase(app, alice, "Live checkout");
      const archived = await createCase(app, alice, "Archived checkout");
      await caseStore.updateCaseMeta({ id: archived.id, status: "archived" });

      const filteredEmpty = parseInvestigationCollectionPage(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: collectionUrl({ q: "no-such-token" }),
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(filteredEmpty.items).toEqual([]);
      expect(filteredEmpty.facets.status.top.find((bucket) => bucket.key === "open")?.count).toBe(1);
      expect(filteredEmpty.facets.status.top.find((bucket) => bucket.key === "archived")?.count).toBe(
        1,
      );

      const hidden = parseInvestigationCollectionPage(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: collectionUrl({ q: "checkout" }),
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(hidden.items.map((item) => item.id)).toEqual([live.id]);
      expect(hidden.hiddenArchivedCount).toBe(1);

      const shown = parseInvestigationCollectionPage(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: collectionUrl({ q: "checkout", includeArchived: "true" }),
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(shown.items.map((item) => item.id).sort()).toEqual([archived.id, live.id].sort());
      expect(shown.hiddenArchivedCount).toBe(0);
    });
  });

  it("isolates authorized facets and conceals a non-member case", async () => {
    await withApp(async ({ app, graph }) => {
      const alice = await login(app, "alice", ALICE);
      const eve = await login(app, "eve", "fixture-eve-secret");
      const aliceCase = await createCase(app, alice, "Alice checkout");
      const eveCase = await createCase(app, eve, "Eve private mailer");
      graph.linkEntity(aliceCase.id, "ent-northwind", "Northwind");
      graph.linkEntity(eveCase.id, "ent-contoso", "Contoso");
      graph.recordImpact(eveCase.id, IMPACT);

      const page = parseInvestigationCollectionPage(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: collectionUrl(),
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(page.items.map((item) => item.id)).toEqual([aliceCase.id]);
      expect(page.facets.entity.top.map((bucket) => bucket.key)).toEqual(["ent-northwind"]);
      expect(page.facets.impactIdentity.top).toEqual([]);
      expect(page.facets.contributor.top).toEqual([]);
      expect(page.facets.contributor.otherCount).toBe(1);
      expect(JSON.stringify(page)).not.toContain(eveCase.id);
      expect(JSON.stringify(page)).not.toContain("ent-contoso");
    });
  });

  it("follows an opaque cursor across pages without repeating identities", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = [
        await createCase(app, alice, "Page one"),
        await createCase(app, alice, "Page two"),
        await createCase(app, alice, "Page three"),
      ];

      const firstResponse = await app.inject({
        method: "GET",
        url: collectionUrl({ limit: "1" }),
        headers: { cookie: alice },
      });
      const first = parseInvestigationCollectionPage(JSON.parse(firstResponse.body));
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toEqual(expect.any(String));

      const seen = new Set(first.items.map((item) => item.id));
      let cursor = first.nextCursor;
      let pages = 1;
      while (cursor && pages < 8) {
        const next = parseInvestigationCollectionPage(
          JSON.parse(
            (
              await app.inject({
                method: "GET",
                url: collectionUrl({ limit: "1", cursor }),
                headers: { cookie: alice },
              })
            ).body,
          ),
        );
        for (const item of next.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = next.nextCursor;
        pages += 1;
      }
      expect([...seen].sort()).toEqual(created.map((item) => item.id).sort());
      expect(cursor).toBeNull();
    });
  });

  it("rejects malformed and unknown query or cursor values with 400", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      await createCase(app, alice, "Cursor fixture");

      const unknownKey = await app.inject({
        method: "GET",
        url: `${collectionUrl()}&extra=1`,
        headers: { cookie: alice },
      });
      expect(unknownKey.statusCode).toBe(400);
      expect(JSON.parse(unknownKey.body).error).toBe("invalid");

      const wrongVersion = await app.inject({
        method: "GET",
        url: "/api/cases?schemaId=cd-collab.investigation_collection_query.v2",
        headers: { cookie: alice },
      });
      expect(wrongVersion.statusCode).toBe(400);

      const wrongQueueVersion = await app.inject({
        method: "GET",
        url: "/api/cases?schemaId=cd-collab.investigation_operations_queue_query.v2",
        headers: { cookie: alice },
      });
      expect(wrongQueueVersion.statusCode).toBe(400);
      const unknownQueueKey = await app.inject({
        method: "GET",
        url: `${operationsQueueUrl()}&workload=1`,
        headers: { cookie: alice },
      });
      expect(unknownQueueKey.statusCode).toBe(400);
      expect(JSON.parse(unknownQueueKey.body).error).toBe("invalid");

      const malformedCursor = await app.inject({
        method: "GET",
        url: collectionUrl({ cursor: "not-a-cursor" }),
        headers: { cookie: alice },
      });
      expect(malformedCursor.statusCode).toBe(400);
      expect(JSON.parse(malformedCursor.body)).toEqual({ error: "malformed_cursor" });

      await createCase(app, alice, "Second cursor fixture");
      const first = parseInvestigationCollectionPage(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: collectionUrl({ limit: "1" }),
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(first.nextCursor).toEqual(expect.any(String));
      const mismatched = await app.inject({
        method: "GET",
        url: collectionUrl({ q: "other", limit: "1", cursor: first.nextCursor ?? "" }),
        headers: { cookie: alice },
      });
      expect(mismatched.statusCode).toBe(400);
      expect(JSON.parse(mismatched.body)).toEqual({ error: "stale_cursor" });
    });
  });

  it("does not read case data when the session cannot read investigations", async () => {
    await withApp(async ({ app, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      await createCase(app, alice, "Must stay unread");
      const before = caseStore.listCalls;
      const queueBefore = caseStore.coordinationSnapshotCalls;
      const coordinationBefore = caseStore.coordinationLookupCalls;

      const unauthenticated = await app.inject({ method: "GET", url: collectionUrl() });
      expect(unauthenticated.statusCode).toBe(401);
      expect(JSON.parse(unauthenticated.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "unauthenticated",
      });
      const unauthenticatedQueue = await app.inject({
        method: "GET",
        url: operationsQueueUrl(),
      });
      expect(unauthenticatedQueue.statusCode).toBe(401);
      expect(caseStore.coordinationSnapshotCalls).toBe(queueBefore);

      const dave = await login(app, "dave", "fixture-dave-secret");
      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/authz/group-role-map",
        headers: { cookie: dave },
        payload: { group: "cn=contributors,ou=groups,dc=example,dc=test" },
      });
      expect(revoked.statusCode).toBe(200);
      const denied = await app.inject({
        method: "GET",
        url: collectionUrl(),
        headers: { cookie: alice },
      });
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "forbidden",
      });
      expect(caseStore.listCalls).toBe(before);

      const deniedQueue = await app.inject({
        method: "GET",
        url: `${operationsQueueUrl({ coordinationScope: "not-a-scope", limit: "not-a-number" })}&workload=1`,
        headers: { cookie: alice },
      });
      expect(deniedQueue.statusCode).toBe(403);
      expect(JSON.parse(deniedQueue.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "forbidden",
      });
      expect(caseStore.listCalls).toBe(before);
      expect(caseStore.coordinationSnapshotCalls).toBe(queueBefore);
      expect(caseStore.coordinationLookupCalls).toBe(coordinationBefore);
    });
  });
});
