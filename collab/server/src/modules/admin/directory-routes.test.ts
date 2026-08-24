import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
  parseAdminDirectoryError,
  parseAdminDirectoryGroupSearchResponse,
  parseAdminDirectoryIdentitySearchResponse,
  type IdentityV1,
} from "@cd-collab/contracts";
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
  type AuthAdapter,
  type DirectorySearchOptions,
} from "../auth/index.js";
import {
  MemoryGroupRoleStore,
  MutableGroupRoleMap,
  parseGroupRoleMap,
} from "../authz/index.js";

type UserRow = { password: string; identity: IdentityV1; groups: string[] };

function users(count = 0): Map<string, UserRow> {
  const rows = new Map<string, UserRow>([
    [
      "admin",
      {
        password: "admin-secret",
        identity: {
          id: "local:admin",
          username: "admin",
          displayName: "Local Administrator",
        },
        groups: ["local:admins"],
      },
    ],
    [
      "viewer",
      {
        password: "viewer-secret",
        identity: {
          id: "local:viewer",
          username: "viewer",
          displayName: "Local Viewer",
        },
        groups: ["local:viewers"],
      },
    ],
  ]);
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, "0");
    rows.set(`person-${suffix}`, {
      password: `person-secret-${suffix}`,
      identity: {
        id: `local:person-${suffix}`,
        username: `person-${suffix}`,
        displayName: `Person ${suffix}`,
      },
      groups: ["local:operators"],
    });
  }
  return rows;
}

async function withApp(
  fn: (context: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: AuditStore;
  }) => Promise<void>,
  options: {
    adapter?: AuthAdapter;
    audit?: AuditStore;
    users?: Map<string, UserRow>;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-admin-directory-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = options.audit ?? new MemoryAuditStore();
  const rows = options.users ?? users();
  const adapter = options.adapter ?? new MapAuthAdapter(rows);
  const roles = new MutableGroupRoleMap(
    parseGroupRoleMap("local:admins=admin;local:viewers=viewer"),
  );
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "local" }),
    pool: null,
    store: evidence,
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
    await fn({ app, audit });
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
    payload: {
      username,
      password: username === "admin" ? "admin-secret" : "viewer-secret",
    },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

function query(term: string): { schemaId: string; term: string } {
  return { schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID, term };
}

describe("admin directory routes", () => {
  it("denies anonymous and non-admin direct API access", async () => {
    await withApp(async ({ app, audit }) => {
      const anonymous = await app.inject({
        method: "POST",
        url: "/api/admin/directory/identities/search",
        payload: query("adm"),
      });
      expect(anonymous.statusCode).toBe(401);

      const viewerCookie = await login(app, "viewer");
      const viewer = await app.inject({
        method: "POST",
        url: "/api/admin/directory/groups/search",
        headers: { cookie: viewerCookie },
        payload: query("adm"),
      });
      expect(viewer.statusCode).toBe(403);
      const events = await audit.list({ action: "admin_directory_search" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ target: "groups", outcome: "denied" });
    });
  });

  it("returns strict privacy-projected local identities and groups", async () => {
    await withApp(async ({ app, audit }) => {
      const cookie = await login(app);
      const identitiesResponse = await app.inject({
        method: "POST",
        url: "/api/admin/directory/identities/search",
        headers: { cookie },
        payload: query("loc"),
      });
      expect(identitiesResponse.statusCode).toBe(200);
      const identities = parseAdminDirectoryIdentitySearchResponse(
        JSON.parse(identitiesResponse.body),
      );
      expect(identities.schemaId).toBe(ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID);
      expect(identities.results.map((item) => item.username)).toEqual([
        "admin",
        "viewer",
      ]);

      const groupsResponse = await app.inject({
        method: "POST",
        url: "/api/admin/directory/groups/search",
        headers: { cookie },
        payload: query("admin"),
      });
      expect(groupsResponse.statusCode).toBe(200);
      const groups = parseAdminDirectoryGroupSearchResponse(
        JSON.parse(groupsResponse.body),
      );
      expect(groups.schemaId).toBe(ADMIN_DIRECTORY_GROUPS_SCHEMA_ID);
      expect(groups.results).toEqual([
        { dn: "local:admins", name: "admins", source: "local" },
      ]);

      const serialized = `${identitiesResponse.body}\n${groupsResponse.body}`;
      expect(serialized).not.toMatch(/secret|password|membership|email/i);
      const events = await audit.list({ action: "admin_directory_search" });
      expect(events.map((event) => event.target)).toEqual(["identities", "groups"]);
      const auditJson = JSON.stringify(events);
      expect(auditJson).not.toContain("Local Administrator");
      expect(auditJson).not.toContain("local:admins");
      expect(auditJson).not.toContain("admin-secret");
    });
  });

  it("rejects unknown fields and out-of-bounds normalized terms", async () => {
    await withApp(async ({ app }) => {
      const cookie = await login(app);
      for (const payload of [
        { ...query("admin"), includeMemberships: true },
        query(" a "),
        query("x".repeat(65)),
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/directory/identities/search",
          headers: { cookie },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(parseAdminDirectoryError(JSON.parse(response.body))).toEqual({
          schemaId: ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
          error: "invalid_request",
        });
      }
    });
  });

  it("truncates results at twenty without retaining a query or result cache", async () => {
    const rows = users(25);
    await withApp(
      async ({ app, audit }) => {
        const cookie = await login(app);
        const first = await app.inject({
          method: "POST",
          url: "/api/admin/directory/identities/search",
          headers: { cookie },
          payload: query("person"),
        });
        const second = await app.inject({
          method: "POST",
          url: "/api/admin/directory/identities/search",
          headers: { cookie },
          payload: query("person"),
        });
        const parsed = parseAdminDirectoryIdentitySearchResponse(JSON.parse(first.body));
        expect(parsed.results).toHaveLength(20);
        expect(second.body).toBe(first.body);
        expect(JSON.stringify(await audit.list())).not.toContain("person-00");
      },
      { users: rows },
    );
  });

  it("maps LDAP timeout and unavailability to a redacted 503", async () => {
    const base = new MapAuthAdapter(users());
    const unavailable: AuthAdapter = {
      authenticate: (username, password) => base.authenticate(username, password),
      lookupGroups: (identity) => base.lookupGroups(identity),
      searchIdentities: async (_term: string, _options: DirectorySearchOptions) => {
        throw new Error("LDAP timeout at ldaps://secret.internal");
      },
      searchDirectoryGroups: async (
        _term: string,
        _options: DirectorySearchOptions,
      ) => {
        throw new Error("LDAP service bind unavailable");
      },
    };
    await withApp(
      async ({ app }) => {
        const cookie = await login(app);
        for (const resource of ["identities", "groups"] as const) {
          const response = await app.inject({
            method: "POST",
            url: `/api/admin/directory/${resource}/search`,
            headers: { cookie },
            payload: query("admin"),
          });
          expect(response.statusCode).toBe(503);
          expect(response.body).not.toMatch(/LDAP|ldaps|secret|bind/i);
          expect(parseAdminDirectoryError(JSON.parse(response.body))).toEqual({
            schemaId: ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
            error: "directory_unavailable",
          });
        }
      },
      { adapter: unavailable },
    );
  });

  it("returns 503 rather than a false forbidden result when live groups fail", async () => {
    const base = new MapAuthAdapter(users());
    const unavailableDuringLiveRoleCheck: AuthAdapter = {
      authenticate: (username, password) => base.authenticate(username, password),
      lookupGroups: async () => {
        throw new Error("LDAP group refresh timeout");
      },
      searchIdentities: (term, options) => base.searchIdentities(term, options),
      searchDirectoryGroups: (term, options) =>
        base.searchDirectoryGroups(term, options),
    };
    await withApp(
      async ({ app }) => {
        const cookie = await login(app);
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/directory/identities/search",
          headers: { cookie },
          payload: query("admin"),
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toMatch(/LDAP|group|timeout/i);
        expect(parseAdminDirectoryError(JSON.parse(response.body)).error).toBe(
          "directory_unavailable",
        );
      },
      { adapter: unavailableDuringLiveRoleCheck },
    );
  });

  it("returns no directory results when the immutable audit writer is unavailable", async () => {
    const rows = users();
    const memory = new MemoryAuditStore();
    const unavailableAudit: AuditStore = {
      append: async (record) => {
        if (
          record.action === "admin_directory_search" &&
          record.outcome === "success"
        ) {
          throw new Error("audit persistence unavailable");
        }
        return memory.append(record);
      },
      list: (filter) => memory.list(filter),
    };
    await withApp(
      async ({ app }) => {
        const cookie = await login(app);
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/directory/identities/search",
          headers: { cookie },
          payload: query("admin"),
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("Local Administrator");
        expect(parseAdminDirectoryError(JSON.parse(response.body))).toEqual({
          schemaId: ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
          error: "directory_unavailable",
        });
      },
      { users: rows, audit: unavailableAudit },
    );
  });
});
