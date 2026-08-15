import { describe, expect, it } from "vitest";
import { LdapAuthAdapter } from "./ldap-adapter.js";
import { loadLdapConfig } from "./ldap-config.js";
import { createAuthLog } from "./log.js";

const configured = Boolean(process.env.COLLAB_LDAP_URL);

describe.skipIf(!configured)("OpenLDAP fixture (encrypted)", () => {
  it("binds a mapped fixture user over encrypted transport", async () => {
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(loadLdapConfig(), log);
    const ok = await adapter.authenticate(
      process.env.COLLAB_LDAP_FIXTURE_USER ?? "alice",
      process.env.COLLAB_LDAP_FIXTURE_PASSWORD ?? "fixture-alice-secret",
    );
    expect(ok).not.toBeNull();
    expect(ok?.identity.username).toBe(
      process.env.COLLAB_LDAP_FIXTURE_USER ?? "alice",
    );
    expect(ok?.groups.some((g) => g.toLowerCase().includes("contributors"))).toBe(
      true,
    );
    expect(log.lines().join("\n")).not.toContain("fixture-alice-secret");
  });

  it("returns null for a wrong password without logging it", async () => {
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(loadLdapConfig(), log);
    const secret = "fixture-wrong-secret";
    const result = await adapter.authenticate("alice", secret);
    expect(result).toBeNull();
    expect(log.lines().join("\n")).not.toContain(secret);
  });
});
