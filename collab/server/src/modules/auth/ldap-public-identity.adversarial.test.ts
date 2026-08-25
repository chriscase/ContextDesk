import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionResponse } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { ExportService, testExportPrivacyConfig } from "../export/index.js";
import { ImportService, MemoryRunStore } from "../import/index.js";
import { MemoryUserProfileStore } from "../people/index.js";
import {
  HmacPublicIdentityCodec,
  LdapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  createSyntheticLdapFactory,
  defaultSessionPolicy,
  exampleSyntheticDirectory,
  loadLdapConfig,
} from "./index.js";

const ALICE_DN = "uid=alice,ou=people,dc=example,dc=test";
const LDAP_ENV = {
  COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
  COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
  COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
  COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
  COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
  COLLAB_LDAP_MEMBER_ATTR: "memberOf",
};

function cookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

function expectNoDn(body: string): void {
  expect(body).not.toContain(ALICE_DN);
  expect(body).not.toMatch(/(?:uid|cn|ou|dc)=[^,]+,(?:uid|cn|ou|dc)=/i);
}

describe("LDAP public identity privacy boundary", () => {
  it("keeps legacy DN attribution internal across auth, profile, activity, timeline, export, and denial responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-ldap-public-id-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const caseStore = new MemoryCaseStore();
    const domain = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({
      evidence,
      audit,
      cases: domain,
      catalog,
      runs: new MemoryRunStore(),
    });
    const exporter = new ExportService({
      cases: domain,
      catalog,
      imports,
      audit,
      privacy: testExportPrivacyConfig({ identityRedactions: {} }),
    });
    const cfg = loadLdapConfig(LDAP_ENV);
    const adapter = new LdapAuthAdapter(
      cfg,
      createAuthLog(),
      createSyntheticLdapFactory(cfg, exampleSyntheticDirectory()),
    );
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(
      "cn=contributors,ou=groups,dc=example,dc=test=admin;cn=unmapped,ou=groups,dc=example,dc=test=viewer",
    ));
    const profiles = new MemoryUserProfileStore();
    const publicIdentities = new HmacPublicIdentityCodec(Buffer.alloc(32, 19));
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root, authMode: "ldap" }),
      pool: null,
      store: evidence,
      domain,
      catalog,
      imports,
      exporter,
      installationId: "inst-syntheticnorth",
      publicIdentities,
      profiles,
      security: {
        auth: {
          adapter,
          sessions: new MemorySessionStore(),
          policy: defaultSessionPolicy,
          roles,
          audit,
          log: createAuthLog(),
          limiter: createRateLimiter({ maxFails: 10, windowMs: 60_000 }),
          cookieSecure: false,
        },
        roles,
        roleStore: new MemoryGroupRoleStore(roles),
        audit,
        ldapConfig: cfg,
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: "fixture-alice-secret" },
      });
      expect(login.statusCode).toBe(200);
      expectNoDn(login.body);
      const publicId = parseSessionResponse(JSON.parse(login.body)).identity.id;
      expect(publicId).toMatch(/^usr-[a-f0-9]{32}$/);
      const alice = cookie(login);

      for (const url of ["/api/auth/me", "/api/profile/me"]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie: alice } });
        expect(response.statusCode).toBe(200);
        expectNoDn(response.body);
        expect((JSON.parse(response.body) as { id?: string; identity?: { id: string } }).id
          ?? (JSON.parse(response.body) as { identity?: { id: string } }).identity?.id).toBe(publicId);
      }

      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic directory attribution review" },
      });
      expect(created.statusCode).toBe(200);
      expectNoDn(created.body);
      const caseId = (JSON.parse(created.body) as { id: string }).id;

      const action = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "action",
          privacyClass: "share_safe",
          body: `Verify the synthetic owner ${ALICE_DN} without exposing its directory path.`,
        },
      });
      expect(action.statusCode).toBe(200);
      expectNoDn(action.body);

      // The authoritative legacy-shaped rows still retain trusted correlation.
      const internalTimeline = await domain.listTimeline(caseId);
      expect(internalTimeline.some((event) => event.actorId === ALICE_DN)).toBe(true);

      const timeline = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/timeline`,
        headers: { cookie: alice },
      });
      expect(timeline.statusCode).toBe(200);
      expectNoDn(timeline.body);
      expect(timeline.body).toContain(publicId);

      const activity = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/investigation-activity?actorId=${encodeURIComponent(publicId)}`,
        headers: { cookie: alice },
      });
      expect(activity.statusCode).toBe(200);
      expectNoDn(activity.body);
      const activityBody = JSON.parse(activity.body) as { items: Array<{ actorId: string }> };
      expect(activityBody.items.length).toBeGreaterThan(0);
      expect(activityBody.items.every((item) => item.actorId === publicId)).toBe(true);

      const exported = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/export/brief`,
        headers: { cookie: alice },
        payload: { variant: "share_safe" },
      });
      expect(exported.statusCode).toBe(200);
      expectNoDn(exported.body);

      const bobLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "bob", password: "fixture-bob-secret" },
      });
      expect(bobLogin.statusCode).toBe(200);
      const deniedAdmin = await app.inject({
        method: "POST",
        url: "/api/admin/directory/identities/search",
        headers: { cookie: cookie(bobLogin) },
        payload: { schemaId: "cd-collab.admin_directory_search_request.v1", term: "ali" },
      });
      expect(deniedAdmin.statusCode).toBe(403);
      expectNoDn(deniedAdmin.body);
      const denied = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/timeline`,
        headers: { cookie: cookie(bobLogin) },
      });
      expect(denied.statusCode).toBe(404);
      expectNoDn(denied.body);

      // General administration surfaces also receive the public projection.
      const adminPeople = await app.inject({
        method: "POST",
        url: "/api/admin/people/search",
        headers: { cookie: alice },
        payload: {
          schemaId: "cd-collab.admin_people_list_request.v1",
          term: "alice",
          status: null,
          provenance: null,
          cursor: null,
          limit: 50,
        },
      });
      expect(adminPeople.statusCode).toBe(200);
      expectNoDn(adminPeople.body);
      expect(adminPeople.body).toContain(publicId);

      // Raw correlation remains available only behind the exact directory diagnostic gate.
      const adminDiagnostic = await app.inject({
        method: "POST",
        url: "/api/admin/directory/identities/search",
        headers: { cookie: alice },
        payload: { schemaId: "cd-collab.admin_directory_search_request.v1", term: "ali" },
      });
      expect(adminDiagnostic.statusCode, adminDiagnostic.body).toBe(200);
      expect(adminDiagnostic.body).toContain(ALICE_DN);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
