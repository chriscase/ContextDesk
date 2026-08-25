/**
 * Shared HTTP harness for the investigation record graph: reusable entities,
 * involvement links, cross-investigation references, and resolutions.
 *
 * Lives outside `src/modules` on purpose. It wires several modules together
 * through their public entry points, which is exactly what a non-module file
 * is allowed to do and a module-local test is not.
 *
 * Every identity, label, and body here is synthetic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { buildApp } from "../app.js";
import { testConfig } from "../config.js";
import { FilesystemEvidenceStore } from "../evidence/store.js";
import { MemoryAuditStore } from "../modules/audit/index.js";
import {
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../modules/authz/index.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { EntityService } from "../modules/entities/index.js";
import { ExportService } from "../modules/export/index.js";
import { ImportService } from "../modules/import/index.js";
import { ReferenceService } from "../modules/references/index.js";
import { ResolutionService } from "../modules/resolutions/index.js";

export const PASSWORDS = {
  alice: "fixture-alice-secret",
  bob: "fixture-bob-secret",
  carol: "fixture-carol-secret",
  dave: "fixture-dave-secret",
} as const;

/**
 * alice and bob are case leads (they can conclude), carol is a viewer, dave is
 * an admin. Two leads exist so cross-investigation authorization can be tested
 * with two people who each see only their own work.
 */
function users() {
  return new Map([
    [
      "alice",
      {
        password: PASSWORDS.alice,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "bob",
      {
        password: PASSWORDS.bob,
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "carol",
      {
        password: PASSWORDS.carol,
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: PASSWORDS.dave,
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

const roleMap = [
  "cn=viewers,ou=groups,dc=example,dc=test=viewer",
  "cn=contributors,ou=groups,dc=example,dc=test=contributor",
  "cn=leads,ou=groups,dc=example,dc=test=case-lead",
  "cn=admins,ou=groups,dc=example,dc=test=admin",
].join(";");

export interface RecordHarness {
  app: Awaited<ReturnType<typeof buildApp>>;
  audit: MemoryAuditStore;
  domain: CaseService;
  entities: EntityService;
  references: ReferenceService;
  resolutions: ResolutionService;
  exporter: ExportService;
}

export async function withRecordApp(fn: (ctx: RecordHarness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-record-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  // Same construction order as production: the guard exists before the case
  // service, and is handed the case service back once it exists.
  const resolutions = new ResolutionService({ audit });
  const domain = new CaseService(store, audit, undefined, catalog, resolutions);
  const investigations = {
    getCase: (id: string, actor: { id: string; username: string }, isAdmin: boolean) =>
      domain.getCase(id, actor, isAdmin),
    appendDomainTimeline: (
      caseId: string,
      event: {
        kind: string;
        actor: { id: string; username: string };
        targetId: string | null;
        clientTime: string | null;
        payload: unknown;
      },
    ) => domain.appendDomainTimeline(caseId, event),
  };
  resolutions.bindInvestigations(investigations);
  const entities = new EntityService({ audit, investigations });
  const references = new ReferenceService({ audit, investigations });
  const imports = new ImportService({ evidence: store, audit, cases: domain, catalog });
  // The same read-only record source production wires, so export behaviour is
  // tested through the real projection rather than a test-only shortcut.
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: { identityRedactions: {}, internalHostnameSuffixes: [] },
    record: {
      involvementFor: (caseId) => entities.involvementsForExport(caseId),
      entityPrivacy: () => entities.entityPrivacyMap(),
      referencesFor: (caseId) => references.exportProjection(caseId),
      activeResolutionFor: (caseId) => resolutions.active(caseId),
    },
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    entities,
    references,
    resolutions,
    imports,
    exporter,
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 50, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });
  try {
    await fn({ app, audit, domain, entities, references, resolutions, exporter });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

export async function login(
  app: RecordHarness["app"],
  username: keyof typeof PASSWORDS,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

export function body(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

export async function createInvestigation(
  app: RecordHarness["app"],
  cookie: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(200);
  return body(res);
}

export async function createEntity(
  app: RecordHarness["app"],
  cookie: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: "POST",
    url: "/api/entities",
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return body(res);
}
