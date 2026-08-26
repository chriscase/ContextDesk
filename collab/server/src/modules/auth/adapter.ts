import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AdminDirectoryGroupV1,
  AdminDirectoryIdentityV1,
  DirectoryMappedField,
  IdentityV1,
} from "@cd-collab/contracts";

export type AuthIdentity = IdentityV1;

export interface AuthSuccess {
  identity: AuthIdentity;
  groups: string[];
  directoryFields?: Partial<Record<DirectoryMappedField, string>>;
}

export interface DirectorySearchOptions {
  limit: number;
  timeoutMs: number;
}

const LOCAL_DIRECTORY_SCAN_LIMIT = 1_000;

/**
 * Directory/SSO seam. The password argument exists only for the duration of
 * this call. Implementations must not store, cache, persist a derived secret,
 * or log it. An ephemeral digest used only to feed a timing-safe compare,
 * then discarded, is allowed.
 * No module outside `auth` may call this with a password — login routes live here.
 */
export interface AuthAdapter {
  /** Which profile provenance a successful authenticate() through this adapter represents. */
  readonly provenance: "local" | "ldap";
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
  readonly provenance = "local" as const;
  /**
   * Synthetic probe used so unknown-user authenticate() still runs the same
   * compare work as a known user. Generated per adapter instance, never logged,
   * never returned, and never a configured user password.
   */
  private readonly unknownUserProbe: string;

  constructor(
    private readonly users: ReadonlyMap<
      string,
      { password: string; identity: AuthIdentity; groups: string[] }
    >,
  ) {
    this.unknownUserProbe = randomBytes(32).toString("base64");
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthSuccess | null> {
    const row = this.users.get(username);
    const expected = row?.password ?? this.unknownUserProbe;
    const matches = passwordsMatch(password, expected);
    if (!row || !matches) return null;
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

/**
 * Timing-safe compare of UTF-8 password bytes. SHA-256 is used only to feed
 * `timingSafeEqual` a fixed-length buffer so a length mismatch cannot throw or
 * early-return. Digests are ephemeral: never stored, logged, or returned.
 */
function passwordsMatch(provided: string, expected: string): boolean {
  const actual = createHash("sha256").update(provided, "utf8").digest();
  const candidate = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actual, candidate);
}

function localGroupName(group: string): string {
  if (group.startsWith("local:") && group.length > "local:".length) {
    return group.slice("local:".length);
  }
  const first = group.split(",", 1)[0] ?? group;
  const equals = first.indexOf("=");
  return equals > 0 ? first.slice(equals + 1) : group;
}
