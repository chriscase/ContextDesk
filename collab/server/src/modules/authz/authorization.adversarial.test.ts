import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IdentityV1 } from "@cd-collab/contracts";
import { parseAuthError } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  MemorySessionStore,
  MapAuthAdapter,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CaseService } from "../cases/index.js";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  MemoryLocalGrantStore,
  MemoryUserProfileStore,
} from "../people/index.js";

type UserRow = { password: string; identity: IdentityV1; groups: string[] };

const VIEWER_PASSWORD = "viewer-secret";
const ADMIN_PASSWORD = "admin-secret";
const ALICE_PASSWORD = "fixture-alice-secret";
const HISTORICAL_PASSWORD = "historical-secret";
const HISTORICAL_ID = "imported:north-installation:actor-42";
const LOG = "2026-08-15T00:00:00Z synthetic mailer timeout id=syn-authz-1\n";

function users(): Map<string, UserRow> {
  return new Map<string, UserRow>([
    [
      "admin",
      {
        password: ADMIN_PASSWORD,
        identity: { id: "local:admin", username: "admin", displayName: "Local Administrator" },
        groups: ["local:admins"],
      },
    ],
    [
      "viewer",
      {
        password: VIEWER_PASSWORD,
        identity: { id: "local:viewer", username: "viewer", displayName: "Local Viewer" },
        groups: ["local:viewers"],
      },
    ],
    [
      "alice",
      {
        password: ALICE_PASSWORD,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["local:contributors"],
      },
    ],
    [
      "historical",
      {
        password: HISTORICAL_PASSWORD,
        identity: {
          id: HISTORICAL_ID,
          username: "historical",
          displayName: "Historical Actor",
        },
        groups: ["local:viewers"],
      },
    ],
  ]);
}

async function withApp(
  fn: (context: {
    app: Awaited<ReturnType<typeof buildApp>>;
    profiles: MemoryUserProfileStore;
    grants: MemoryLocalGrantStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-authz-adversarial-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const adapter = new MapAuthAdapter(users());
  const roles = new MutableGroupRoleMap(
    parseGroupRoleMap(
      "local:admins=admin;local:viewers=viewer;local:contributors=contributor",
    ),
  );
  const profiles = new MemoryUserProfileStore();
  const grants = new MemoryLocalGrantStore();
  const domain = new CaseService(evidence, audit);
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "local" }),
    pool: null,
    store: evidence,
    domain,
    profiles,
    grants,
    security: {
      auth: {
        adapter,
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      roleStore: new MemoryGroupRoleStore(roles),
      audit,
    },
  });
  try {
    await fn({ app, profiles, grants });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeader(response);
}

describe("authorization and suspension enforcement", () => {
  it("rejects login for a suspended user and treats an existing session as unauthenticated", async () => {
    await withApp(async ({ app, profiles }) => {
      const viewerCookie = await login(app, "viewer", VIEWER_PASSWORD);
      const listed = await app.inject({
        method: "GET",
        url: "/api/cases",
        headers: { cookie: viewerCookie },
      });
      expect(listed.statusCode).toBe(200);

      const current = await profiles.getById("local:viewer");
      if (!current) throw new Error("setup failed");
      const suspended = await profiles.setStatus("local:viewer", "suspended", current.revision);
      expect(suspended.outcome).toBe("ok");

      const reused = await app.inject({
        method: "GET",
        url: "/api/cases",
        headers: { cookie: viewerCookie },
      });
      expect(reused.statusCode).toBe(401);
      expect(parseAuthError(JSON.parse(reused.body)).error).toBe("unauthenticated");

      const adminCookie = await login(app, "admin", ADMIN_PASSWORD);
      const adminSuspend = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "suspended",
          expectedRevision: current.revision + 1,
          idempotencyKey: `suspend-viewer-${randomUUID()}`,
        },
      });
      expect(adminSuspend.statusCode).toBe(200);

      const loginDenied = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "viewer", password: VIEWER_PASSWORD },
      });
      expect(loginDenied.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(loginDenied.body)).error).toBe("access_denied");
      expect(loginDenied.headers["set-cookie"]).toBeUndefined();
    });
  });

  it("lets a viewer with an investigation:write grant create a case, then stops the write after revoke", async () => {
    await withApp(async ({ app, grants }) => {
      const viewerCookie = await login(app, "viewer", VIEWER_PASSWORD);
      const denied = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: viewerCookie },
        payload: { title: "Viewer must not create without a grant" },
      });
      expect(denied.statusCode).toBe(403);

      await grants.grant("local:viewer", "investigation:write", "local:admin");
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: viewerCookie },
        payload: { title: "Granted viewer investigation" },
      });
      expect(created.statusCode).toBe(200);
      expect((JSON.parse(created.body) as { title: string }).title).toBe(
        "Granted viewer investigation",
      );

      await grants.revoke("local:viewer", "investigation:write");
      const afterRevoke = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: viewerCookie },
        payload: { title: "Grant was revoked" },
      });
      expect(afterRevoke.statusCode).toBe(403);
    });
  });

  it("requires evidence:private:read for owner_only bytes even for a case member", async () => {
    await withApp(async ({ app, grants }) => {
      const aliceCookie = await login(app, "alice", ALICE_PASSWORD);
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: aliceCookie },
        payload: { title: "Private evidence case" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = (JSON.parse(created.body) as { id: string }).id;
      const uploaded = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: aliceCookie },
            payload: {
              kind: "log",
              filename: "app.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from(LOG).toString("base64"),
              summary: "Synthetic owner_only log",
              privacyClass: "owner_only",
            },
          })
        ).body,
      ) as { artifact: { id: string } };

      const denied = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${uploaded.artifact.id}/bytes`,
        headers: { cookie: aliceCookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(JSON.parse(denied.body)).toEqual({ error: "not_found" });

      await grants.grant(
        "uid=alice,ou=people,dc=example,dc=test",
        "evidence:private:read",
        "local:admin",
      );
      const allowed = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${uploaded.artifact.id}/bytes`,
        headers: { cookie: aliceCookie },
      });
      expect(allowed.statusCode).toBe(200);
      expect(
        Buffer.from(
          (JSON.parse(allowed.body) as { contentBase64: string }).contentBase64,
          "base64",
        ).toString("utf8"),
      ).toBe(LOG);

      await grants.revoke(
        "uid=alice,ou=people,dc=example,dc=test",
        "evidence:private:read",
      );
      const afterRevoke = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${uploaded.artifact.id}/bytes`,
        headers: { cookie: aliceCookie },
      });
      expect(afterRevoke.statusCode).toBe(404);
      expect(JSON.parse(afterRevoke.body)).toEqual({ error: "not_found" });
    });
  });

  it("refuses login for an imported_historical identity even with valid adapter credentials", async () => {
    await withApp(async ({ app, profiles }) => {
      const seeded = await profiles.touchOnLogin({
        id: HISTORICAL_ID,
        username: "historical",
        displayName: "Historical Actor",
        provenance: "imported_historical",
        directorySubject: HISTORICAL_ID,
      });
      expect(seeded.outcome).toBe("ok");

      const denied = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "historical", password: HISTORICAL_PASSWORD },
      });
      expect(denied.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(denied.body)).error).toBe("access_denied");
      expect(denied.headers["set-cookie"]).toBeUndefined();
    });
  });

  it("gates People search and admin audit on admin:users, not the admin role, and keeps system-config separate", async () => {
    await withApp(async ({ app }) => {
      const viewerCookie = await login(app, "viewer", VIEWER_PASSWORD);
      const searchDenied = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: viewerCookie },
        payload: {
          schemaId: "cd-collab.admin_people_list_request.v1",
          term: "",
          status: null,
          provenance: null,
          cursor: null,
          limit: 50,
        },
      });
      expect(searchDenied.statusCode).toBe(403);

      const auditDenied = await app.inject({
        method: "GET",
        url: "/api/admin/audit",
        headers: { cookie: viewerCookie },
      });
      expect(auditDenied.statusCode).toBe(403);

      const adminCookie = await login(app, "admin", ADMIN_PASSWORD);
      const grant = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/grants",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_grant_request.v1",
          capability: "admin:users",
          idempotencyKey: `grant-admin-users-${randomUUID()}`,
        },
      });
      expect(grant.statusCode).toBe(200);

      const searchAllowed = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: viewerCookie },
        payload: {
          schemaId: "cd-collab.admin_people_list_request.v1",
          term: "",
          status: null,
          provenance: null,
          cursor: null,
          limit: 50,
        },
      });
      expect(searchAllowed.statusCode).toBe(200);

      const mapDenied = await app.inject({
        method: "GET",
        url: "/api/authz/group-role-map",
        headers: { cookie: viewerCookie },
      });
      expect(mapDenied.statusCode).toBe(403);

      const auditStillDenied = await app.inject({
        method: "GET",
        url: "/api/admin/audit",
        headers: { cookie: viewerCookie },
      });
      expect(auditStillDenied.statusCode).toBe(403);
    });
  });
});
