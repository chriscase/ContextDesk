import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseInvestigationActivityPage,
  parseInvestigationResourceResolve,
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

const ALICE = "fixture-alice-secret";
const INSTALLATION = "inst-syntheticnorth";
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
  ]);
}

async function withApp(
  fn: (ctx: { app: Awaited<ReturnType<typeof buildApp>> }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-activity-http-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const domain = new CaseService(store, audit);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    installationId: INSTALLATION,
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
    await fn({ app });
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

describe("investigation activity routes", () => {
  it("requires authentication and keeps the legacy activity feed unchanged", async () => {
    await withApp(async ({ app }) => {
      const unauth = await app.inject({ method: "GET", url: "/api/investigation-activity" });
      expect(unauth.statusCode).toBe(401);
      const alice = await login(app, "alice", ALICE);
      const created = JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic queue investigation" },
      })).body) as { id: string };
      const legacy = await app.inject({
        method: "GET",
        url: "/api/activity?limit=10",
        headers: { cookie: alice },
      });
      expect(legacy.statusCode).toBe(200);
      expect(JSON.parse(legacy.body).schemaId).toBe("cd-collab.activity_feed.v1");
      const scoped = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/investigation-activity`,
        headers: { cookie: alice },
      });
      expect(scoped.statusCode).toBe(200);
    });
  });

  it("walks Overview activity to an authorized resource and survives reload", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const eve = await login(app, "eve", "fixture-eve-secret");
      const created = JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic queue investigation" },
      })).body) as { id: string };
      await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "log",
          filename: "app.log",
          mediaType: "text/plain",
          contentBase64: Buffer.from("2026-08-24T00:00:00Z mailer timeout id=syn-1\n").toString("base64"),
          summary: "Synthetic mailer timeout log",
        },
      });
      const first = await app.inject({
        method: "GET",
        url: "/api/investigation-activity?limit=10",
        headers: { cookie: alice },
      });
      expect(first.statusCode).toBe(200);
      const page = parseInvestigationActivityPage(JSON.parse(first.body));
      const evidence = page.items.find((item) => item.activityKind === "evidence_added");
      expect(evidence).toBeTruthy();
      expect(evidence?.locator.investigationId).toBe(created.id);
      const resolvedRes = await app.inject({
        method: "GET",
        url: `/api/investigation-resources/resolve?locator=${encodeURIComponent(
          `cdl.v1/${INSTALLATION}/${created.id}/evidence_item/${evidence!.locator.resourceId}`,
        )}`,
        headers: { cookie: alice },
      });
      expect(resolvedRes.statusCode).toBe(200);
      const resolved = parseInvestigationResourceResolve(JSON.parse(resolvedRes.body));
      expect(resolved.locator.pathname).toBe(evidence!.resolvedRoute);
      expect(resolved.locator.resourceId).toBe(evidence!.locator.resourceId);
      const reload = await app.inject({
        method: "GET",
        url: "/api/investigation-activity?limit=10",
        headers: { cookie: alice },
      });
      const reloaded = parseInvestigationActivityPage(JSON.parse(reload.body));
      expect(reloaded.items.find((item) => item.activityId === evidence!.activityId)?.resolvedRoute)
        .toBe(evidence!.resolvedRoute);
      const eveResolve = await app.inject({
        method: "GET",
        url: `/api/investigation-resources/resolve?locator=${encodeURIComponent(
          `cdl.v1/${INSTALLATION}/${created.id}/evidence_item/${evidence!.locator.resourceId}`,
        )}`,
        headers: { cookie: eve },
      });
      expect(eveResolve.statusCode).toBe(404);
      expect(JSON.parse(eveResolve.body).error).toBe("not_found");
      const traversal = await app.inject({
        method: "GET",
        url: `/api/investigation-resources/resolve?locator=${encodeURIComponent(
          `cdl.v1/${INSTALLATION}/${created.id}/evidence_item/..%2f..%2fetc%2fpasswd`,
        )}`,
        headers: { cookie: alice },
      });
      expect(traversal.statusCode).toBe(400);
      const malformed = await app.inject({
        method: "GET",
        url: "/api/investigation-activity?cursor=%%%",
        headers: { cookie: alice },
      });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body).error).toBe("malformed_cursor");
    });
  });
});
