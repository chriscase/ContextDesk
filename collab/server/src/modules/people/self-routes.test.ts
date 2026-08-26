import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED_DIRECTORY_SUBJECT, type IdentityV1, type UserProfileV1 } from "@cd-collab/contracts";
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
  SESSION_COOKIE,
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
    sessions: MemorySessionStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-self-profile-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const adapter = new MapAuthAdapter(users());
  const roles = new MutableGroupRoleMap(parseGroupRoleMap("local:viewers=viewer"));
  const profiles = new MemoryUserProfileStore();
  const grants = new MemoryLocalGrantStore();
  const sessions = new MemorySessionStore();
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "local" }),
    pool: null,
    store: evidence,
    profiles,
    grants,
    security: {
      auth: {
        adapter,
        sessions,
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
    await fn({ app, audit, profiles, sessions });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "viewer", password: "viewer-secret" },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

describe("self profile routes", () => {
  it("requires an authenticated session", async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({ method: "GET", url: "/api/profile/me" });
      expect(response.statusCode).toBe(401);
    });
  });

  it("returns the caller's own profile, created by login-time sync", async () => {
    await withApp(async ({ app }) => {
      const cookie = await login(app);
      const response = await app.inject({ method: "GET", url: "/api/profile/me", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const profile = response.json() as { username: string; provenance: string; displayName: string };
      expect(profile.username).toBe("viewer");
      expect(profile.provenance).toBe("local");
      expect(profile.displayName).toBe("Local Viewer");
    });
  });

  it("edits a local-editable field with CSRF + CAS, and rejects a stale revision", async () => {
    await withApp(async ({ app }) => {
      const cookie = await login(app);
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: 1,
          contactOther: "Slack: @viewer",
        },
      });
      expect(patch.statusCode).toBe(200);
      const profile = patch.json() as { contactOther: string; revision: number };
      expect(profile.contactOther).toBe("Slack: @viewer");
      expect(profile.revision).toBe(2);

      const stale = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: 1,
          contactOther: "second attempt",
        },
      });
      expect(stale.statusCode).toBe(409);
    });
  });

  it("rejects a mutation without the CSRF header", async () => {
    await withApp(async ({ app }) => {
      const cookie = await login(app);
      const patch = await injectWithoutBrowserCsrf(app, {
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: 1,
          contactOther: "no csrf header",
        },
      });
      expect(patch.statusCode).toBe(403);
    });
  });

  it("blocks writes from a suspended profile even with a valid session and correct revision", async () => {
    await withApp(async ({ app, profiles }) => {
      const cookie = await login(app);
      const current = await profiles.getById("local:viewer");
      if (!current) throw new Error("setup failed");
      await profiles.setStatus("local:viewer", "suspended", current.revision);

      const patch = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: current.revision + 1,
          contactOther: "should be refused",
        },
      });
      expect(patch.statusCode).toBe(401);
      expect((patch.json() as { error: string }).error).toBe("unauthenticated");
    });
  });

  it("keeps a directory-owned field read-only for an ldap-provenance profile but leaves contactOther self-editable", async () => {
    await withApp(async ({ app, profiles, sessions }) => {
      const directorySubject = "uid=dana,ou=people,dc=example,dc=test";
      const created = await profiles.touchOnLogin({
        id: directorySubject,
        username: "dana",
        displayName: "Dana",
        provenance: "ldap",
        directorySubject,
        directoryFields: { displayName: "Dana Directory", team: "Directory Team" },
      });
      if (created.outcome !== "ok") throw new Error("setup failed");

      const { token } = await sessions.create({
        identity: { id: directorySubject, username: "dana", displayName: "Dana Directory" },
        groups: ["local:viewers"],
        ttlMs: defaultSessionPolicy.ttlMs,
      });
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

      const blocked = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: created.profile.revision,
          team: "Self-Chosen Team",
        },
      });
      expect(blocked.statusCode).toBe(403);
      expect((blocked.json() as { error: string }).error).toBe("field_not_editable");

      const allowed = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: created.profile.revision,
          contactOther: "Pager: dana",
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect((allowed.json() as { team: string }).team).toBe("Directory Team");
      expect((allowed.json() as { contactOther: string }).contactOther).toBe("Pager: dana");
    });
  });

  it("never ships the raw directory subject to the profile owner on GET or PATCH", async () => {
    await withApp(async ({ app, profiles, sessions }) => {
      // A DN whose every component is distinctive, so a substring assertion
      // cannot pass by accident.
      const directorySubject = "uid=erin,ou=eastwing,ou=people,dc=example,dc=test";
      const created = await profiles.touchOnLogin({
        id: directorySubject,
        username: "erin",
        displayName: "Erin",
        provenance: "ldap",
        directorySubject,
        directoryFields: { displayName: "Erin Directory" },
      });
      if (created.outcome !== "ok") throw new Error("setup failed");

      const { token } = await sessions.create({
        identity: { id: directorySubject, username: "erin", displayName: "Erin Directory" },
        groups: ["local:viewers"],
        ttlMs: defaultSessionPolicy.ttlMs,
      });
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

      const read = await app.inject({ method: "GET", url: "/api/profile/me", headers: { cookie } });
      expect(read.statusCode).toBe(200);
      for (const fragment of ["ou=eastwing", "ou=people", "dc=example", "uid=erin"]) {
        expect(read.body).not.toContain(fragment);
      }
      const readBody = read.json() as UserProfileV1;
      expect(readBody.directorySubject).toBe(REDACTED_DIRECTORY_SUBJECT);
      // The linkage indicator, the display fields, and the sync state survive.
      expect(readBody.provenance).toBe("ldap");
      expect(readBody.displayName).toBe("Erin Directory");
      expect(readBody.username).toBe("erin");
      expect(readBody.directorySyncStatus).toBe("synced");

      const patch = await app.inject({
        method: "PATCH",
        url: "/api/profile/me",
        headers: { cookie, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        payload: {
          schemaId: "cd-collab.user_profile_update_request.v1",
          expectedRevision: readBody.revision,
          contactOther: "Pager: erin",
        },
      });
      expect(patch.statusCode).toBe(200);
      for (const fragment of ["ou=eastwing", "ou=people", "dc=example", "uid=erin"]) {
        expect(patch.body).not.toContain(fragment);
      }
      expect((patch.json() as UserProfileV1).directorySubject).toBe(REDACTED_DIRECTORY_SUBJECT);

      // Redaction is a response projection only - the store still holds the
      // real subject for the admin surfaces that need it.
      const stored = await profiles.getByUsername("erin");
      expect(stored?.directorySubject).toBe(directorySubject);
    });
  });
});
