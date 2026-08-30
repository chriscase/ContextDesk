import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  parseCase,
  parseInvestigationLifecycle,
  parseInvestigationLifecycleActionRefused,
  parseInvestigationLifecycleActionSuccess,
  parseInvestigationLifecycleChanged,
  type InvestigationLifecycleV1,
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
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, type StatusResolutionGuard } from "./service.js";

const ALICE = "fixture-alice-secret";
const DAVE = "fixture-dave-secret";
const ERIN = "fixture-erin-secret";

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
      "dave",
      {
        password: DAVE,
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "erin",
      {
        password: ERIN,
        identity: {
          id: "uid=erin,ou=people,dc=example,dc=test",
          username: "erin",
          displayName: "erin",
        },
        groups: ["cn=case-leads,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const roleMap = [
  "cn=contributors,ou=groups,dc=example,dc=test=contributor",
  "cn=case-leads,ou=groups,dc=example,dc=test=case-lead",
  "cn=admins,ou=groups,dc=example,dc=test=admin",
].join(";");

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    domain: CaseService;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  resolutionGuard?: StatusResolutionGuard,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-lifecycle-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog, resolutionGuard);
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
    await fn({ app, domain, audit });
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

async function openCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: session },
    payload: {
      title: "Synthetic lifecycle fixture",
      severity: "low",
      problemStatement: "Synthetic fixture for archive and restore behaviour.",
    },
  });
  expect(created.statusCode).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

async function setStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  status: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/status`,
    headers: { cookie: session },
    payload: { status },
  });
}

async function setHold(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  legalHold: boolean,
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/legal-hold`,
    headers: { cookie: session },
    payload: { legalHold },
  });
  expect(res.statusCode).toBe(200);
}

async function lifecycle(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
): Promise<InvestigationLifecycleV1> {
  const response = await app.inject({
    method: "GET",
    url: `/api/cases/${caseId}/lifecycle`,
    headers: { cookie: session },
  });
  expect(response.statusCode).toBe(200);
  return parseInvestigationLifecycle(JSON.parse(response.body));
}

function actionPayload(
  preview: InvestigationLifecycleV1,
  action: "archive" | "restore",
): Record<string, unknown> {
  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: preview.investigationId,
    action,
    expected: {
      status: preview.status,
      legalHold: preview.legalHold,
      restoreTarget: preview.restoreTarget,
    },
  };
}

async function applyAction(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/lifecycle`,
    ...(session ? { headers: { cookie: session } } : {}),
    payload,
  });
}

describe("atomic lifecycle command", () => {
  it("returns contract-parsed archive and restore successes using the server-derived target", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      expect((await setStatus(app, dave, caseId, "monitoring")).statusCode).toBe(200);

      const beforeArchive = await lifecycle(app, dave, caseId);
      const archivedResponse = await applyAction(
        app,
        dave,
        caseId,
        actionPayload(beforeArchive, "archive"),
      );
      expect(archivedResponse.statusCode).toBe(200);
      const archived = parseInvestigationLifecycleActionSuccess(JSON.parse(archivedResponse.body));
      expect(archived).toMatchObject({
        action: "archive",
        previousStatus: "monitoring",
        appliedStatus: "archived",
        case: { id: caseId, status: "archived" },
      });

      const beforeRestore = await lifecycle(app, dave, caseId);
      expect(beforeRestore.restore).toMatchObject({ allowed: true, targetStatus: "monitoring" });
      const restoredResponse = await applyAction(
        app,
        dave,
        caseId,
        actionPayload(beforeRestore, "restore"),
      );
      expect(restoredResponse.statusCode).toBe(200);
      const restored = parseInvestigationLifecycleActionSuccess(JSON.parse(restoredResponse.body));
      expect(restored).toMatchObject({
        action: "restore",
        previousStatus: "archived",
        appliedStatus: "monitoring",
        case: { id: caseId, status: "monitoring" },
      });
    });
  });

  it("returns a parsed changed-state conflict after legal hold changes and writes no action rows", async () => {
    await withApp(async ({ app, domain, audit }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      const stale = await lifecycle(app, dave, caseId);
      await setHold(app, dave, caseId, true);
      const timelineBefore = await domain.listTimeline(caseId);
      const actionAuditBefore = await audit.list({ action: "case_status" });

      const response = await applyAction(app, dave, caseId, actionPayload(stale, "archive"));
      expect(response.statusCode, response.body).toBe(409);
      const conflict = parseInvestigationLifecycleChanged(JSON.parse(response.body));
      expect(conflict).toMatchObject({
        error: "lifecycle_changed",
        action: "archive",
        current: { status: "open", legalHold: true, archive: { allowed: false, reason: "legal_hold" } },
      });
      expect(await domain.listTimeline(caseId)).toEqual(timelineBefore);
      expect(await audit.list({ action: "case_status" })).toEqual(actionAuditBefore);
      expect((await domain.getCase(caseId, { id: "ignored", username: "ignored" }, true))?.status).toBe("open");
    });
  });

  it("emits a bounded, versioned refusal with action and investigation identity", async () => {
    await withApp(async ({ app, domain, audit }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setHold(app, dave, caseId, true);
      const preview = await lifecycle(app, dave, caseId);
      const timelineBefore = await domain.listTimeline(caseId);
      const actionAuditBefore = await audit.list({ action: "case_status" });

      const response = await applyAction(app, dave, caseId, actionPayload(preview, "archive"));
      expect(response.statusCode, response.body).toBe(409);
      expect(parseInvestigationLifecycleActionRefused(JSON.parse(response.body))).toMatchObject({
        error: "lifecycle_refused",
        investigationId: caseId,
        action: "archive",
        reason: "legal_hold",
      });
      expect((await domain.getCase(caseId, { id: "ignored", username: "ignored" }, true)))
        .toMatchObject({ status: "open", legalHold: true });
      expect(await domain.listTimeline(caseId)).toEqual(timelineBefore);
      expect(await audit.list({ action: "case_status" })).toEqual(actionAuditBefore);
    });
  });

  it("restores an archived investigation while it is under legal hold", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");
      const archivePreview = await lifecycle(app, dave, caseId);
      expect(
        (await applyAction(app, dave, caseId, actionPayload(archivePreview, "archive"))).statusCode,
      ).toBe(200);
      await setHold(app, dave, caseId, true);

      const restorePreview = await lifecycle(app, dave, caseId);
      const response = await applyAction(
        app,
        dave,
        caseId,
        actionPayload(restorePreview, "restore"),
      );
      expect(response.statusCode).toBe(200);
      expect(parseInvestigationLifecycleActionSuccess(JSON.parse(response.body))).toMatchObject({
        action: "restore",
        appliedStatus: "monitoring",
        case: { legalHold: true },
      });
    });
  });

  it("keeps request contract violations and path/body identity mismatches at 400", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      const preview = await lifecycle(app, dave, caseId);

      const selectedTarget = await applyAction(app, dave, caseId, {
        ...actionPayload(preview, "archive"),
        targetStatus: "archived",
      });
      expect(selectedTarget.statusCode).toBe(400);
      expect(selectedTarget.body).toMatch(/targetStatus/);

      const wrongId = await applyAction(app, dave, caseId, {
        ...actionPayload(preview, "archive"),
        investigationId: "case-other",
      });
      expect(wrongId.statusCode).toBe(400);
      expect(wrongId.body).toMatch(/investigationId/);
    });
  });
});

describe("lifecycle route authorization order", () => {
  it("checks session, run capability, and concealed case access before parsing", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const alice = await login(app, "alice", ALICE);
      const erin = await login(app, "erin", ERIN);
      const caseId = await openCase(app, dave);
      const invalid = { targetStatus: "archived" };

      expect((await applyAction(app, "", caseId, invalid)).statusCode).toBe(401);
      expect((await applyAction(app, alice, caseId, invalid)).statusCode).toBe(403);
      const concealed = await applyAction(app, erin, caseId, invalid);
      expect(concealed.statusCode).toBe(404);
      expect(concealed.body).not.toMatch(/targetStatus|legalHold/);
    });
  });
});

describe("generic status and lifecycle boundaries", () => {
  it("rejects archive and restore on the generic route with a bounded 400 command pointer", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);

      const genericArchive = await setStatus(app, dave, caseId, "archived");
      expect(genericArchive.statusCode).toBe(400);
      expect(JSON.parse(genericArchive.body)).toEqual({
        error: "lifecycle_action_required",
        investigationId: caseId,
        action: "archive",
        endpoint: `/api/cases/${caseId}/lifecycle`,
      });

      const preview = await lifecycle(app, dave, caseId);
      expect((await applyAction(app, dave, caseId, actionPayload(preview, "archive"))).statusCode).toBe(200);
      const genericRestore = await setStatus(app, dave, caseId, "monitoring");
      expect(genericRestore.statusCode).toBe(400);
      expect(JSON.parse(genericRestore.body)).toMatchObject({
        error: "lifecycle_action_required",
        action: "restore",
      });
    });
  });

  it("keeps ordinary working status changes available under legal hold", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setHold(app, dave, caseId, true);
      const moved = await setStatus(app, dave, caseId, "monitoring");
      expect(moved.statusCode).toBe(200);
      expect(parseCase(JSON.parse(moved.body))).toMatchObject({ status: "monitoring", legalHold: true });
    });
  });

  it("never consults the resolution guard for generic archive or restore attempts", async () => {
    const authorizeStatus = vi.fn<StatusResolutionGuard["authorizeStatus"]>(async () => undefined);
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);

      expect((await setStatus(app, dave, caseId, "archived")).statusCode).toBe(400);
      expect(authorizeStatus).not.toHaveBeenCalled();

      const preview = await lifecycle(app, dave, caseId);
      expect(
        (await applyAction(app, dave, caseId, actionPayload(preview, "archive"))).statusCode,
      ).toBe(200);
      expect(authorizeStatus).not.toHaveBeenCalled();

      expect((await setStatus(app, dave, caseId, "monitoring")).statusCode).toBe(400);
      expect(authorizeStatus).not.toHaveBeenCalled();
    }, { authorizeStatus });
  });
});

describe("lifecycle preview", () => {
  it("returns the full parsed contract shape and conceals non-member reads", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");

      expect(await lifecycle(app, dave, caseId)).toMatchObject({
        investigationId: caseId,
        status: "monitoring",
        archive: { allowed: true, action: "archive", targetStatus: "archived" },
        restore: { allowed: false, action: "restore", reason: "not_archived" },
        restoreTarget: "monitoring",
        deletion: { supported: false, alternatives: ["archive"] },
      });

      const concealed = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/lifecycle`,
        headers: { cookie: alice },
      });
      expect(concealed.statusCode).toBe(404);
      expect(concealed.body).not.toMatch(/legalHold/);
    });
  });
});
