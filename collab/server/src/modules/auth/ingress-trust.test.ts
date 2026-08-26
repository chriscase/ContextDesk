import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAuthError } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig, type Config } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, type AuditStore } from "../audit/index.js";
import {
  MemoryGroupRoleStore,
  MutableGroupRoleMap,
  parseGroupRoleMap,
} from "../authz/index.js";
import { MapAuthAdapter } from "./adapter.js";
import { createAuthLog } from "./log.js";
import { createRateLimiter } from "./rate-limit.js";
import { MemorySessionStore, defaultSessionPolicy } from "./sessions.js";

const GROUP = "cn=contributors,ou=groups,dc=example,dc=test";
const ROLE_MAP = `${GROUP}=contributor`;
const PASSWORD = "fixture-alice-secret";

/** The reverse proxy the ingress terminates TLS on. */
const PROXY = "127.0.0.1";
const CLIENT_A = "203.0.113.9";
const CLIENT_B = "198.51.100.7";

function users() {
  return new Map([
    [
      "alice",
      {
        password: PASSWORD,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: [GROUP],
      },
    ],
  ]);
}

async function withProxiedApp(
  trustProxy: Config["trustProxy"],
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: AuditStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-ingress-"));
  const audit = new MemoryAuditStore();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(ROLE_MAP));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, trustProxy }),
    pool: null,
    store: new FilesystemEvidenceStore({ rootDir: root }),
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 2, windowMs: 60_000 }),
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

function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  client: string,
  password: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: PROXY,
    headers: { "x-forwarded-for": client },
    payload: { username: "alice", password },
  });
}

describe("client address behind a TLS-terminating reverse proxy", () => {
  it("keeps one client's failed logins from rate-limiting everyone else", async () => {
    await withProxiedApp(1, async ({ app }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await login(app, CLIENT_A, "fixture-wrong-secret");
      }
      const blocked = await login(app, CLIENT_A, PASSWORD);
      expect(blocked.statusCode).toBe(429);
      expect(parseAuthError(JSON.parse(blocked.body)).error).toBe("rate_limited");

      const other = await login(app, CLIENT_B, PASSWORD);
      expect(other.statusCode).toBe(200);
    });
  });

  it("records the forwarded client, not the proxy, as the audit origin", async () => {
    await withProxiedApp(1, async ({ app, audit }) => {
      const ok = await login(app, CLIENT_A, PASSWORD);
      expect(ok.statusCode).toBe(200);
      const events = await audit.list({ action: "login" });
      expect(events.map((event) => event.origin)).toContain(CLIENT_A);
      expect(events.map((event) => event.origin)).not.toContain(PROXY);
    });
  });

  it("pins the undeclared-ingress failure mode this setting exists to fix", async () => {
    // Without a declared ingress every request shares the proxy's address, so
    // one user's failed logins lock out the whole workspace and no audit
    // record can attribute an origin. That is correct for a directly exposed
    // deployment and wrong behind a proxy - hence the explicit setting.
    await withProxiedApp(null, async ({ app, audit }) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await login(app, CLIENT_A, "fixture-wrong-secret");
      }
      const unrelated = await login(app, CLIENT_B, PASSWORD);
      expect(unrelated.statusCode).toBe(429);
      const events = await audit.list({ action: "login" });
      expect(events.every((event) => event.origin === PROXY)).toBe(true);
    });
  });

  it("ignores forwarded addresses when no ingress is declared", async () => {
    await withProxiedApp(null, async ({ app, audit }) => {
      const ok = await login(app, CLIENT_A, PASSWORD);
      expect(ok.statusCode).toBe(200);
      const events = await audit.list({ action: "login" });
      expect(events.map((event) => event.origin)).not.toContain(CLIENT_A);
    });
  });
});
