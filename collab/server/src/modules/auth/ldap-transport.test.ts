import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { LdapAuthAdapter } from "./ldap-adapter.js";
import { loadLdapConfig, type LdapConfig } from "./ldap-config.js";
import { createLiveLdapFactory } from "./ldap-live.js";
import { probeLdap } from "./ldap-probe.js";
import { createAuthLog } from "./log.js";

/**
 * A loopback port that nothing is listening on. Bind, read the assigned port,
 * then release it: no fixture directory, no outbound network, and the same
 * behaviour on every supported platform.
 */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  expect(port).toBeGreaterThan(0);
  return port;
}

async function unreachableLdapsConfig(): Promise<LdapConfig> {
  const port = await closedLoopbackPort();
  return loadLdapConfig({
    COLLAB_LDAP_URL: `ldaps://127.0.0.1:${port}`,
    COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
    COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
    COLLAB_LDAP_TIMEOUT_MS: "1000",
  } as NodeJS.ProcessEnv);
}

describe("LDAPS transport is proven, not assumed", () => {
  it("fails the handshake when the directory cannot be reached", async () => {
    const config = await unreachableLdapsConfig();
    const session = createLiveLdapFactory(config)();
    // The LDAPS handshake tolerates a *refused* anonymous Root DSE read,
    // because that is the directory answering over an established socket. A
    // connect failure is not an answer and must not pass as one.
    await expect(session.handshake()).rejects.toThrow();
    await session.unbind();
  });

  it("reports an unreachable directory as a failed transport stage", async () => {
    const config = await unreachableLdapsConfig();
    const report = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: null,
      probePassword: null,
      resolveRoles: () => ["viewer"],
      roleMapConfigured: true,
    });
    expect(report.ready).toBe(false);
    const byId = new Map(report.stages.map((stage) => [stage.id, stage]));
    expect(byId.get("transport")?.status).toBe("failed");
    expect(byId.get("transport")?.detail).not.toMatch(/available/i);
    for (const id of ["service_bind", "user_search", "group_lookup", "role_map"] as const) {
      expect(byId.get(id)?.status, id).toBe("not_run");
    }
  });

  it("keeps login fail-closed and password-free when transport fails", async () => {
    const config = await unreachableLdapsConfig();
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(config, log);
    const secret = "fixture-unreachable-secret";
    await expect(adapter.authenticate("alice", secret)).resolves.toBeNull();
    const lines = log.lines().join("\n");
    expect(lines).toMatch(/ldap_bind_failed/);
    expect(lines).not.toContain(secret);
  });
});
