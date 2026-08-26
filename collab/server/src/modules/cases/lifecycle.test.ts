import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCase } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
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
import { CaseService } from "./service.js";

const ALICE = "fixture-alice-secret";
const DAVE = "fixture-dave-secret";

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
  ]);
}

const roleMap =
  "cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    domain: CaseService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-lifecycle-"));
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
    await fn({ app, domain });
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

describe("legal hold refuses an archive", () => {
  it("refuses the transition and leaves the recorded status untouched", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");
      await setHold(app, dave, caseId, true);

      const refused = await setStatus(app, dave, caseId, "archived");
      expect(refused.statusCode).toBe(409);
      const body = JSON.parse(refused.body) as { error: string; reason: string; detail: string };
      expect(body.error).toBe("lifecycle_refused");
      expect(body.reason).toBe("legal_hold");
      expect(body.detail).toMatch(/legal hold/i);

      // Nothing half-written: the investigation is exactly as it was.
      const after = parseCase(
        JSON.parse(
          (await app.inject({ method: "GET", url: `/api/cases/${caseId}`, headers: { cookie: dave } }))
            .body,
        ),
      );
      expect(after.status).toBe("monitoring");
      expect(after.legalHold).toBe(true);
    });
  });

  it("permits the archive once the hold is cleared", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setHold(app, dave, caseId, true);
      expect((await setStatus(app, dave, caseId, "archived")).statusCode).toBe(409);
      await setHold(app, dave, caseId, false);
      const allowed = await setStatus(app, dave, caseId, "archived");
      expect(allowed.statusCode).toBe(200);
      expect(parseCase(JSON.parse(allowed.body)).status).toBe("archived");
    });
  });

  it("never traps a held record: restore still works under hold", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");
      expect((await setStatus(app, dave, caseId, "archived")).statusCode).toBe(200);
      await setHold(app, dave, caseId, true);

      const restored = await setStatus(app, dave, caseId, "monitoring");
      expect(restored.statusCode).toBe(200);
      expect(parseCase(JSON.parse(restored.body)).status).toBe("monitoring");
    });
  });
});

describe("ordinary status changes are unaffected", () => {
  it("moves between working statuses without consulting the lifecycle guard", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      // A hold refuses archiving, and nothing else. An ordinary transition
      // under hold must still go through, or the hold silently freezes work.
      await setHold(app, dave, caseId, true);
      const moved = await setStatus(app, dave, caseId, "monitoring");
      expect(moved.statusCode).toBe(200);
      expect(parseCase(JSON.parse(moved.body)).status).toBe("monitoring");
    });
  });
});

describe("restore lands on the recorded prior status", () => {
  it("reports monitoring for an investigation archived out of monitoring", async () => {
    await withApp(async ({ app, domain }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");
      await setStatus(app, dave, caseId, "archived");
      expect((await domain.lifecycleFor(caseId)).restoreTarget).toBe("monitoring");
    });
  });

  it("reports open for an investigation archived straight from open", async () => {
    await withApp(async ({ app, domain }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "archived");
      expect((await domain.lifecycleFor(caseId)).restoreTarget).toBe("open");
    });
  });
});

describe("the lifecycle route answers before the click", () => {
  it("describes an allowed archive and where a restore would land", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setStatus(app, dave, caseId, "monitoring");

      const res = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/lifecycle`,
        headers: { cookie: dave },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        schemaId: string;
        status: string;
        legalHold: boolean;
        archive: { allowed: boolean };
        restore: { allowed: boolean; reason?: string };
        restoreTarget: string;
        deletion: { supported: boolean; detail: string };
      };
      expect(body.schemaId).toBe("cd-collab.investigation_lifecycle.v1");
      expect(body.status).toBe("monitoring");
      expect(body.archive.allowed).toBe(true);
      expect(body.restore.allowed).toBe(false);
      expect(body.restore.reason).toBe("not_archived");
      expect(body.restoreTarget).toBe("monitoring");
      expect(body.deletion.supported).toBe(false);
    });
  });

  it("reports the hold as the reason an archive is unavailable", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      await setHold(app, dave, caseId, true);

      const body = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${caseId}/lifecycle`,
            headers: { cookie: dave },
          })
        ).body,
      ) as { legalHold: boolean; archive: { allowed: boolean; reason?: string } };
      expect(body.legalHold).toBe(true);
      expect(body.archive.allowed).toBe(false);
      expect(body.archive.reason).toBe("legal_hold");
    });
  });

  it("refuses the read to a caller with no session", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const caseId = await openCase(app, dave);
      const res = await app.inject({ method: "GET", url: `/api/cases/${caseId}/lifecycle` });
      expect(res.statusCode).toBe(401);
    });
  });

  it("reports not_found for an investigation the caller is not a member of", async () => {
    await withApp(async ({ app }) => {
      const dave = await login(app, "dave", DAVE);
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, dave);
      // Alice is a contributor on this installation but not a participant on
      // this investigation. The lifecycle read must not leak that it exists,
      // let alone whether it is under hold.
      const res = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/lifecycle`,
        headers: { cookie: alice },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toMatch(/legalHold/);
    });
  });
});
