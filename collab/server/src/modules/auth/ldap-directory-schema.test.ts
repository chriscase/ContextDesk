import { describe, expect, it } from "vitest";
import { LdapAuthAdapter } from "./ldap-adapter.js";
import { loadLdapConfig, type LdapConfig } from "./ldap-config.js";
import { createSyntheticLdapFactory, type SyntheticGroup } from "./ldap-synthetic.js";
import { createAuthLog } from "./log.js";

const PEOPLE_BASE = "ou=people,dc=example,dc=test";
const GROUP_BASE = "ou=groups,dc=example,dc=test";

function serviceBoundConfig(): LdapConfig {
  return loadLdapConfig({
    COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
    COLLAB_LDAP_USER_SEARCH_BASE: PEOPLE_BASE,
    COLLAB_LDAP_GROUP_SEARCH_BASE: GROUP_BASE,
    COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
    COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
  } as NodeJS.ProcessEnv);
}

function adapterFor(groups: SyntheticGroup[]): LdapAuthAdapter {
  const config = serviceBoundConfig();
  return new LdapAuthAdapter(
    config,
    createAuthLog(),
    createSyntheticLdapFactory(config, {
      service: {
        dn: "cn=svc,ou=services,dc=example,dc=test",
        password: "fixture-service-secret",
      },
      people: [
        {
          dn: `uid=alice,${PEOPLE_BASE}`,
          uid: "alice",
          password: "fixture-alice-secret",
          attrs: { cn: ["Alice Fixture"] },
        },
      ],
      groups,
    }),
  );
}

describe("administrative group search across directory schemas", () => {
  it("finds Active Directory groups, which carry no groupOfNames class", async () => {
    const adapter = adapterFor([
      {
        dn: `cn=collab-admins,${GROUP_BASE}`,
        cn: "collab-admins",
        members: [`uid=alice,${PEOPLE_BASE}`],
        objectClass: ["top", "group"],
      },
    ]);
    expect(await adapter.searchDirectoryGroups("collab", { limit: 20, timeoutMs: 3_000 })).toEqual([
      { dn: `cn=collab-admins,${GROUP_BASE}`, name: "collab-admins", source: "ldap" },
    ]);
  });

  it("still finds OpenLDAP groupOfNames, groupOfUniqueNames, and posixGroup", async () => {
    const adapter = adapterFor([
      {
        dn: `cn=collab-names,${GROUP_BASE}`,
        cn: "collab-names",
        members: [],
        objectClass: ["top", "groupOfNames"],
      },
      {
        dn: `cn=collab-unique,${GROUP_BASE}`,
        cn: "collab-unique",
        members: [],
        objectClass: ["top", "groupOfUniqueNames"],
      },
      {
        dn: `cn=collab-posix,${GROUP_BASE}`,
        cn: "collab-posix",
        members: [],
        objectClass: ["top", "posixGroup"],
      },
    ]);
    const found = await adapter.searchDirectoryGroups("collab", { limit: 20, timeoutMs: 3_000 });
    expect(found.map((group) => group.name)).toEqual([
      "collab-names",
      "collab-posix",
      "collab-unique",
    ]);
  });

  it("does not widen the picker to non-group entries under the group base", async () => {
    const adapter = adapterFor([
      {
        dn: `cn=collab-contacts,${GROUP_BASE}`,
        cn: "collab-contacts",
        members: [],
        objectClass: ["top", "organizationalUnit"],
      },
    ]);
    expect(
      await adapter.searchDirectoryGroups("collab", { limit: 20, timeoutMs: 3_000 }),
    ).toEqual([]);
  });
});
