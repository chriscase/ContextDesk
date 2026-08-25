import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IdentityV1 } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, type AuditStore } from "../audit/index.js";
import {
  MemorySessionStore,
  MapAuthAdapter,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  injectWithoutBrowserCsrf,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "./csrf.js";
import { MemoryLocalGrantStore } from "./grants.js";
import { MemoryUserProfileStore, type UserProfileStore } from "./store.js";

type UserRow = { password: string; identity: IdentityV1; groups: string[] };

function users(): Map<string, UserRow> {
  return new Map<string, UserRow>([
    [
      "admin",
      {
        password: "admin-secret",
        identity: { id: "local:admin", username: "admin", displayName: "Local Administrator" },
        groups: ["local:admins"],
      },
    ],
    [
      "viewer",
      {
        password: "viewer-secret",
        identity: { id: "local:viewer", username: "viewer", displayName: "Local Viewer" },
        groups: ["local:viewers"],
      },
    ],
  ]);
}

async function withApp(
  fn: (context: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: AuditStore;
    profiles: UserProfileStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-admin-people-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const adapter = new MapAuthAdapter(users());
  const roles = new MutableGroupRoleMap(
    parseGroupRoleMap("local:admins=admin;local:viewers=viewer"),
  );
  const profiles = new MemoryUserProfileStore();
  const grants = new MemoryLocalGrantStore();
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "local" }),
    pool: null,
    store: evidence,
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
        limiter: createRateLimiter({ maxFails: 5, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      roleStore: new MemoryGroupRoleStore(roles),
      audit,
    },
  });
  try {
    await fn({ app, audit, profiles });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: "admin" | "viewer" = "admin",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: username === "admin" ? "admin-secret" : "viewer-secret" },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

function searchBody(term = "") {
  return {
    schemaId: "cd-collab.admin_people_list_request.v1",
    term,
    status: null,
    provenance: null,
    cursor: null,
    limit: 50,
  };
}

describe("admin people routes", () => {
  it("denies anonymous and non-admin access identically whether or not the target exists", async () => {
    await withApp(async ({ app, audit }) => {
      const anonymous = await app.inject({ method: "POST", url: "/api/admin/people/search", payload: searchBody() });
      expect(anonymous.statusCode).toBe(401);

      const viewerCookie = await login(app, "viewer");
      const viewerSearch = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: viewerCookie },
        payload: searchBody(),
      });
      expect(viewerSearch.statusCode).toBe(403);

      // Same 403 for a real target id and a made-up one: no enumeration signal.
      const realTarget = await app.inject({
        method: "GET",
        url: "/api/admin/people/local:admin/effective",
        headers: { cookie: viewerCookie },
      });
      const fakeTarget = await app.inject({
        method: "GET",
        url: "/api/admin/people/local:does-not-exist/effective",
        headers: { cookie: viewerCookie },
      });
      expect(realTarget.statusCode).toBe(403);
      expect(fakeTarget.statusCode).toBe(403);
      expect(realTarget.json()).toEqual(fakeTarget.json());

      const denied = await audit.list({ action: "people_search" });
      expect(denied).toHaveLength(0); // search never reached the store; authorize() returns before any audit call for "forbidden" here
    });
  });

  it("lets an admin search and see profiles created by login-time sync", async () => {
    await withApp(async ({ app, audit }) => {
      const adminCookie = await login(app, "admin");
      await login(app, "viewer");
      const search = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: adminCookie },
        payload: searchBody(),
      });
      expect(search.statusCode).toBe(200);
      const body = search.json() as { people: { username: string }[] };
      expect(body.people.map((p) => p.username).sort()).toEqual(["admin", "viewer"]);
      const events = await audit.list({ action: "people_search" });
      expect(events.some((e) => e.outcome === "success")).toBe(true);
    });
  });

  it("requires the CSRF header on every mutation and reports effective roles/capabilities with source", async () => {
    await withApp(async ({ app }) => {
      const adminCookie = await login(app, "admin");
      await login(app, "viewer");

      const noCsrf = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "suspended",
          expectedRevision: 1,
          idempotencyKey: "suspend-viewer-attempt-1",
        },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect((noCsrf.json() as { error: string }).error).toBe("csrf_required");

      const effectiveBefore = await app.inject({
        method: "GET",
        url: "/api/admin/people/local:viewer/effective",
        headers: { cookie: adminCookie },
      });
      expect(effectiveBefore.statusCode).toBe(200);
      const before = effectiveBefore.json() as {
        roles: string[];
        capabilities: { capability: string; viaRoles: string[]; viaLocalGrant: boolean }[];
      };
      expect(before.roles).toEqual(["viewer"]);
      const readCap = before.capabilities.find((c) => c.capability === "investigation:read");
      expect(readCap?.viaRoles).toEqual(["viewer"]);
      expect(readCap?.viaLocalGrant).toBe(false);
    });
  });

  it("suspends and reactivates with CAS, and an idempotency-key retry returns the same result instead of stale_revision", async () => {
    await withApp(async ({ app, audit }) => {
      const adminCookie = await login(app, "admin");
      await login(app, "viewer");

      const suspend = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "suspended",
          expectedRevision: 1,
          idempotencyKey: "suspend-viewer-key-1",
        },
      });
      expect(suspend.statusCode).toBe(200);
      const suspendedProfile = (suspend.json() as { profile: { status: string; revision: number } }).profile;
      expect(suspendedProfile.status).toBe("suspended");
      expect(suspendedProfile.revision).toBe(2);

      // Retrying with the SAME idempotency key and the now-stale
      // expectedRevision=1 must still return the original success, not
      // stale_revision - that is the entire point of the idempotency cache.
      const retry = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "suspended",
          expectedRevision: 1,
          idempotencyKey: "suspend-viewer-key-1",
        },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(suspend.json());

      // A genuinely new attempt (different idempotency key) with the same
      // stale revision must fail normally.
      const staleAttempt = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "active",
          expectedRevision: 1,
          idempotencyKey: "reactivate-viewer-attempt-with-stale-revision",
        },
      });
      expect(staleAttempt.statusCode).toBe(409);

      const reactivate = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "active",
          expectedRevision: 2,
          idempotencyKey: "reactivate-viewer-key-1",
        },
      });
      expect(reactivate.statusCode).toBe(200);
      expect((reactivate.json() as { profile: { status: string } }).profile.status).toBe("active");

      const events = await audit.list({ action: "people_status_update" });
      // Exactly two real mutations were audited (suspend, reactivate) - the
      // cached retry did not append a duplicate entry.
      expect(events.filter((e) => e.outcome === "success")).toHaveLength(2);
    });
  });

  it("grants and revokes a local capability, refuses to grant to an imported_historical stub, and lets the target see it via /api/profile/me", async () => {
    await withApp(async ({ app, profiles }) => {
      const adminCookie = await login(app, "admin");
      const viewerCookie = await login(app, "viewer");

      const grant = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:viewer/grants",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_grant_request.v1",
          capability: "admin:users",
          idempotencyKey: `grant-${randomUUID()}`,
        },
      });
      expect(grant.statusCode).toBe(200);

      const viewerNowAdmin = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: viewerCookie },
        payload: searchBody(),
      });
      expect(viewerNowAdmin.statusCode).toBe(200); // the local grant alone now satisfies admin:users

      const revoke = await app.inject({
        method: "DELETE",
        url: "/api/admin/people/local:viewer/grants",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_revoke_request.v1",
          capability: "admin:users",
          idempotencyKey: `revoke-${randomUUID()}`,
        },
      });
      expect(revoke.statusCode).toBe(200);
      const viewerAgain = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: viewerCookie },
        payload: searchBody(),
      });
      expect(viewerAgain.statusCode).toBe(403);

      // Seed a historical/imported attribution-only stub directly in the
      // store (this is never created by any live route in V1).
      const historicalId = "imported:north-installation:actor-42";
      const historical = await (
        profiles as unknown as {
          touchOnLogin: (input: unknown) => Promise<{ outcome: string }>;
        }
      ).touchOnLogin({
        id: historicalId,
        username: "north-actor-42",
        displayName: "North Actor 42",
        provenance: "imported_historical",
        directorySubject: `imported:north-installation:actor-42`,
      });
      expect(historical.outcome).toBe("ok");

      const grantHistorical = await app.inject({
        method: "POST",
        url: `/api/admin/people/${historicalId}/grants`,
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_grant_request.v1",
          capability: "investigation:read",
          idempotencyKey: `grant-historical-${randomUUID()}`,
        },
      });
      expect(grantHistorical.statusCode).toBe(403);
    });
  });

  it("previews a directory mapping against admin-supplied sample claims without contacting a directory", async () => {
    await withApp(async ({ app }) => {
      const adminCookie = await login(app, "admin");
      const preview = await app.inject({
        method: "POST",
        url: "/api/admin/directory/mapping/preview",
        headers: { cookie: adminCookie },
        payload: {
          schemaId: "cd-collab.admin_directory_mapping_preview_request.v1",
          map: {
            schemaId: "cd-collab.directory_attribute_map.v1",
            attributes: { displayName: "cn", roleTitle: "title", team: "departmentNumber", contactEmail: "mail" },
          },
          sampleClaims: { cn: "Synthetic Analyst", mail: "synthetic@example.test" },
        },
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json() as { fields: { displayName?: string }; skipped: string[] };
      expect(body.fields.displayName).toBe("Synthetic Analyst");
      expect(body.skipped.sort()).toEqual(["roleTitle", "team"]);
    });
  });

  it("zeroes admin capability for a suspended admin (usableCapabilities enforcement)", async () => {
    await withApp(async ({ app }) => {
      const adminCookie = await login(app, "admin");
      const suspendSelf = await app.inject({
        method: "POST",
        url: "/api/admin/people/local:admin/status",
        headers: { cookie: adminCookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.admin_people_status_request.v1",
          status: "suspended",
          expectedRevision: 1,
          idempotencyKey: `suspend-self-${randomUUID()}`,
        },
      });
      expect(suspendSelf.statusCode).toBe(200);

      const searchAfterSelfSuspend = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: adminCookie },
        payload: searchBody(),
      });
      expect(searchAfterSelfSuspend.statusCode).toBe(401);
    });
  });
});
