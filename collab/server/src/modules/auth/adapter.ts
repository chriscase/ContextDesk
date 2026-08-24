import type {
  AdminDirectoryGroupV1,
  AdminDirectoryIdentityV1,
  IdentityV1,
} from "@cd-collab/contracts";

export type AuthIdentity = IdentityV1;

export interface AuthSuccess {
  identity: AuthIdentity;
  groups: string[];
}

export interface DirectorySearchOptions {
  limit: number;
  timeoutMs: number;
}

const LOCAL_DIRECTORY_SCAN_LIMIT = 1_000;

/**
 * Directory/SSO seam. The password argument exists only for the duration of
 * this call. Implementations must not store, cache, hash, or log it.
 * No module outside `auth` may call this with a password — login routes live here.
 */
export interface AuthAdapter {
  authenticate(username: string, password: string): Promise<AuthSuccess | null>;
  /**
   * Live directory groups for an already-authenticated identity.
   * Must not require the user password. Failures should throw so callers
   * can fail closed instead of keeping login-time groups.
   */
  lookupGroups(identity: AuthIdentity): Promise<string[]>;
  /** Bounded, allowlisted administrative directory visibility. */
  searchIdentities(
    term: string,
    options: DirectorySearchOptions,
  ): Promise<AdminDirectoryIdentityV1[]>;
  /** Never returns group membership rosters. */
  searchDirectoryGroups(
    term: string,
    options: DirectorySearchOptions,
  ): Promise<AdminDirectoryGroupV1[]>;
}

export class MapAuthAdapter implements AuthAdapter {
  constructor(
    private readonly users: ReadonlyMap<
      string,
      { password: string; identity: AuthIdentity; groups: string[] }
    >,
  ) {}

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthSuccess | null> {
    const row = this.users.get(username);
    if (!row || row.password !== password) return null;
    return { identity: row.identity, groups: [...row.groups] };
  }

  async lookupGroups(identity: AuthIdentity): Promise<string[]> {
    for (const row of this.users.values()) {
      if (row.identity.id === identity.id) return [...row.groups];
    }
    return [];
  }

  async searchIdentities(
    term: string,
    options: DirectorySearchOptions,
  ): Promise<AdminDirectoryIdentityV1[]> {
    const needle = term.toLocaleLowerCase("en-US");
    const matches: AdminDirectoryIdentityV1[] = [];
    let scanned = 0;
    for (const row of this.users.values()) {
      if (scanned >= LOCAL_DIRECTORY_SCAN_LIMIT) break;
      scanned += 1;
      const identity: AdminDirectoryIdentityV1 = {
        id: row.identity.id,
        username: row.identity.username,
        displayName: row.identity.displayName.trim() || row.identity.username,
        source: "local" as const,
      };
      if (
        [identity.id, identity.username, identity.displayName].some((value) =>
          value.toLocaleLowerCase("en-US").startsWith(needle),
        )
      ) {
        matches.push(identity);
      }
    }
    return matches
      .sort((a, b) =>
        a.username.localeCompare(b.username) || a.id.localeCompare(b.id),
      )
      .slice(0, options.limit);
  }

  async searchDirectoryGroups(
    term: string,
    options: DirectorySearchOptions,
  ): Promise<AdminDirectoryGroupV1[]> {
    const needle = term.toLocaleLowerCase("en-US");
    const groups = new Set<string>();
    let scanned = 0;
    for (const row of this.users.values()) {
      if (scanned >= LOCAL_DIRECTORY_SCAN_LIMIT) break;
      scanned += 1;
      for (const group of row.groups) groups.add(group);
    }
    return [...groups]
      .map((dn) => ({ dn, name: localGroupName(dn), source: "local" as const }))
      .filter((group) =>
        [group.dn, group.name].some((value) =>
          value.toLocaleLowerCase("en-US").startsWith(needle),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.dn.localeCompare(b.dn))
      .slice(0, options.limit);
  }
}

function localGroupName(group: string): string {
  if (group.startsWith("local:") && group.length > "local:".length) {
    return group.slice("local:".length);
  }
  const first = group.split(",", 1)[0] ?? group;
  const equals = first.indexOf("=");
  return equals > 0 ? first.slice(equals + 1) : group;
}
