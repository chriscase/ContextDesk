/**
 * Deterministic MapAuthAdapter identities. These match collab HTTP tests
 * (`fixture-*-secret`) and are not production credentials.
 */
export interface FixtureUser {
  username: string;
  password: string;
  displayName: string;
  identityId: string;
  groups: string[];
  expectedRoles: string[];
}

const people = "ou=people,dc=example,dc=test";
const groups = "ou=groups,dc=example,dc=test";

export const FIXTURE_USERS = {
  alice: {
    username: "alice",
    password: "fixture-alice-secret",
    displayName: "alice",
    identityId: `uid=alice,${people}`,
    groups: [`cn=contributors,${groups}`],
    expectedRoles: ["contributor"],
  },
  bob: {
    username: "bob",
    password: "fixture-bob-secret",
    displayName: "bob",
    identityId: `uid=bob,${people}`,
    groups: [`cn=unmapped,${groups}`],
    expectedRoles: [],
  },
  carol: {
    username: "carol",
    password: "fixture-carol-secret",
    displayName: "carol",
    identityId: `uid=carol,${people}`,
    groups: [`cn=viewers,${groups}`],
    expectedRoles: ["viewer"],
  },
  dave: {
    username: "dave",
    password: "fixture-dave-secret",
    displayName: "dave",
    identityId: `uid=dave,${people}`,
    groups: [`cn=admins,${groups}`],
    expectedRoles: ["admin"],
  },
  erin: {
    username: "erin",
    password: "fixture-erin-secret",
    displayName: "erin",
    identityId: `uid=erin,${people}`,
    groups: [`cn=leads,${groups}`],
    expectedRoles: ["case-lead"],
  },
} as const satisfies Record<string, FixtureUser>;

export const FIXTURE_ROLE_MAP =
  `cn=viewers,${groups}=viewer;` +
  `cn=contributors,${groups}=contributor;` +
  `cn=leads,${groups}=case-lead;` +
  `cn=admins,${groups}=admin`;

export const SEEDED_SOURCES = {
  chatA: "Fixture chat assistant",
  chatB: "Fixture second assistant",
} as const;

export function adapterUsers(): Map<
  string,
  {
    password: string;
    identity: { id: string; username: string; displayName: string };
    groups: string[];
  }
> {
  const out = new Map<
    string,
    {
      password: string;
      identity: { id: string; username: string; displayName: string };
      groups: string[];
    }
  >();
  for (const user of Object.values(FIXTURE_USERS)) {
    out.set(user.username, {
      password: user.password,
      identity: {
        id: user.identityId,
        username: user.username,
        displayName: user.displayName,
      },
      groups: [...user.groups],
    });
  }
  return out;
}
