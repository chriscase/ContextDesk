import {
  LDAP_MAX_GROUPS,
  mapDirectoryClaimsToProfileFields,
  type DirectoryMappedField,
} from "@cd-collab/contracts";
import type {
  AuthAdapter,
  AuthIdentity,
  AuthSuccess,
  DirectorySearchOptions,
} from "./adapter.js";
import type { LdapConfig } from "./ldap-config.js";
import { escapeDn, escapeFilter, interpolate } from "./ldap-escape.js";
import { createLiveLdapFactory } from "./ldap-live.js";
import {
  parseLoginName,
  normalizeGroupDns,
  sameIgnoreCase,
} from "./ldap-resolution.js";
import {
  DirectoryClaimsUnsafeError,
  LdapUnavailableError,
  directoryStrings,
  firstDirectoryString,
  type LdapSession,
  type LdapSessionFactory,
} from "./ldap-session.js";
import type { AuthLog } from "./log.js";

export { escapeDn, escapeFilter } from "./ldap-escape.js";
export { ldapClientOptions, ldapTlsOptions } from "./ldap-tls.js";

function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  return `${err.name}: ${err.message}`.slice(0, 160);
}

export function directoryIdentityFilter(term: string): string {
  const escaped = escapeFilter(term);
  return `(&(objectClass=person)(|(uid=${escaped}*)(cn=${escaped}*)(displayName=${escaped}*)))`;
}

export function directoryGroupFilter(term: string): string {
  return `(&(objectClass=groupOfNames)(cn=${escapeFilter(term)}*))`;
}

function userFilter(config: LdapConfig, username: string): string {
  return interpolate(config.userSearchFilter, {
    username: escapeFilter(username),
  });
}

function claimAttributes(config: LdapConfig): string[] {
  const attrs = new Set<string>([
    "uid",
    "cn",
    "sAMAccountName",
    "userPrincipalName",
    ...Object.values(config.attributeMap.attributes),
  ]);
  if (config.memberAttribute) attrs.add(config.memberAttribute);
  return [...attrs];
}

function claimsFromEntry(entry: Record<string, unknown>): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "dn") continue;
    const text = firstDirectoryString(value);
    if (text) claims[key] = text;
  }
  return claims;
}

export class LdapAuthAdapter implements AuthAdapter {
  readonly provenance = "ldap" as const;

  constructor(
    private readonly config: LdapConfig,
    private readonly log: AuthLog,
    private readonly sessions: LdapSessionFactory = createLiveLdapFactory(config),
  ) {}

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthSuccess | null> {
    if (!username || !password) return null;
    const parsed = parseLoginName(username);
    if (!parsed.ok) return null;
    const client = this.sessions();
    try {
      await this.startTransport(client);
      const resolved = await this.resolveIdentity(client, parsed, password);
      if (!resolved) {
        this.log.event({ event: "ldap_bind_failed", username: parsed.username, detail: "no_dn" });
        return null;
      }
      const groups = await this.collectGroups(client, resolved.dn, resolved.memberOf);
      const directoryFields = this.mapClaims(resolved.claims);
      this.log.event({ event: "ldap_bind_ok", username: resolved.username });
      return {
        identity: {
          id: resolved.dn,
          username: resolved.username,
          displayName: directoryFields?.displayName ?? resolved.username,
        },
        groups,
        directoryFields,
      };
    } catch (err) {
      if (err instanceof DirectoryClaimsUnsafeError) throw err;
      this.log.event({
        event: "ldap_bind_failed",
        username: parsed.ok ? parsed.username : "invalid",
        detail: errorDetail(err),
      });
      return null;
    } finally {
      await safeUnbind(client);
    }
  }

  async lookupGroups(identity: AuthIdentity): Promise<string[]> {
    const client = this.sessions();
    try {
      await this.startTransport(client);
      if (this.config.bindDn && this.config.bindPassword) {
        await client.bind(this.config.bindDn, this.config.bindPassword);
      }
      const loaded = await this.loadEntry(client, identity.id, identity.username);
      return await this.collectGroups(client, identity.id, loaded?.memberOf ?? []);
    } finally {
      await safeUnbind(client);
    }
  }

  async searchIdentities(term: string, options: DirectorySearchOptions) {
    const base = directoryUserSearchBase(this.config);
    if (!base) throw new Error("LDAP user search base unavailable");
    const client = this.directoryClient(options.timeoutMs);
    try {
      await this.startDirectorySession(client);
      const { searchEntries } = await client.search(base, {
        scope: "sub",
        filter: directoryIdentityFilter(term),
        attributes: ["uid", "cn", "displayName"],
        sizeLimit: boundedLimit(options.limit),
      });
      return searchEntries
        .map((entry) => {
          const id = typeof entry.dn === "string" ? entry.dn : "";
          const username = firstDirectoryString(entry.uid);
          const displayName =
            firstDirectoryString(entry.displayName) ?? firstDirectoryString(entry.cn) ?? username;
          if (!id || !username || !displayName) return null;
          return { id, username, displayName, source: "ldap" as const };
        })
        .filter((entry) => entry !== null)
        .sort((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id))
        .slice(0, boundedLimit(options.limit));
    } finally {
      await safeUnbind(client);
    }
  }

  async searchDirectoryGroups(term: string, options: DirectorySearchOptions) {
    if (!this.config.groupSearchBase) {
      throw new Error("LDAP group search base unavailable");
    }
    const client = this.directoryClient(options.timeoutMs);
    try {
      await this.startDirectorySession(client);
      const { searchEntries } = await client.search(this.config.groupSearchBase, {
        scope: "sub",
        filter: directoryGroupFilter(term),
        attributes: ["cn"],
        sizeLimit: boundedLimit(options.limit),
      });
      return searchEntries
        .map((entry) => {
          const dn = typeof entry.dn === "string" ? entry.dn : "";
          const name = firstDirectoryString(entry.cn);
          if (!dn || !name) return null;
          return { dn, name, source: "ldap" as const };
        })
        .filter((entry) => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.dn.localeCompare(b.dn))
        .slice(0, boundedLimit(options.limit));
    } finally {
      await safeUnbind(client);
    }
  }

  private directoryClient(_timeoutMs: number): LdapSession {
    return this.sessions();
  }

  private async startDirectorySession(client: LdapSession): Promise<void> {
    if (!this.config.bindDn || !this.config.bindPassword) {
      throw new Error("LDAP directory search requires service bind");
    }
    await this.startTransport(client);
    await client.bind(this.config.bindDn, this.config.bindPassword);
  }

  private async startTransport(client: LdapSession): Promise<void> {
    await client.handshake();
  }

  private async resolveIdentity(
    client: LdapSession,
    parsed: Extract<ReturnType<typeof parseLoginName>, { ok: true }>,
    password: string,
  ): Promise<{
    dn: string;
    username: string;
    claims: Record<string, string>;
    memberOf: string[];
  } | null> {
    if (parsed.form === "upn") {
      if (
        !this.config.userResolutionModes.includes("upn") ||
        !this.config.upnSuffix ||
        !sameIgnoreCase(parsed.suffix, this.config.upnSuffix)
      ) {
        return null;
      }
      const resolved = await this.bindThenLoad(
        client,
        `${parsed.username}@${this.config.upnSuffix}`,
        password,
        parsed.username,
      );
      return resolved === "invalid" ? null : resolved;
    }
    if (parsed.form === "domain") {
      if (
        !this.config.userResolutionModes.includes("domain_backslash") ||
        !this.config.netbiosDomain ||
        !sameIgnoreCase(parsed.netbios, this.config.netbiosDomain)
      ) {
        return null;
      }
      const resolved = await this.bindThenLoad(
        client,
        `${this.config.netbiosDomain}\\${parsed.username}`,
        password,
        parsed.username,
      );
      return resolved === "invalid" ? null : resolved;
    }
    for (const mode of this.config.userResolutionModes) {
      const resolved = await this.resolveByMode(client, mode, parsed.username, password);
      if (resolved === "invalid") return null;
      if (resolved) return resolved;
    }
    return null;
  }

  private async resolveByMode(
    client: LdapSession,
    mode: LdapConfig["userResolutionModes"][number],
    username: string,
    password: string,
  ): Promise<
    | {
        dn: string;
        username: string;
        claims: Record<string, string>;
        memberOf: string[];
      }
    | "invalid"
    | null
  > {
    if (mode === "dn_template") {
      if (!this.config.userDnTemplate) return null;
      const dn = interpolate(this.config.userDnTemplate, { username: escapeDn(username) });
      try {
        await client.bind(dn, password);
      } catch {
        return "invalid";
      }
      const loaded = await this.loadEntry(client, dn, username);
      return loaded ?? { dn, username, claims: {}, memberOf: [] };
    }
    if (mode === "service_bind_search") {
      const dn = await this.searchUniqueDn(client, username, true);
      if (dn === "ambiguous") return "invalid";
      if (!dn) return null;
      try {
        await client.bind(dn, password);
      } catch {
        return "invalid";
      }
      const loaded = await this.loadEntry(client, dn, username);
      return loaded ?? { dn, username, claims: {}, memberOf: [] };
    }
    if (mode === "upn") {
      if (!this.config.upnSuffix) return null;
      return this.bindThenLoad(client, `${username}@${this.config.upnSuffix}`, password, username);
    }
    if (mode === "domain_backslash") {
      if (!this.config.netbiosDomain) return null;
      return this.bindThenLoad(
        client,
        `${this.config.netbiosDomain}\\${username}`,
        password,
        username,
      );
    }
    return null;
  }

  /**
   * Prove the password with UPN or DOMAIN\\user, then resolve the DN.
   * Bind failure returns null so a later configured mode may run.
   * A successful bind that cannot uniquely load the entry returns "invalid"
   * so we do not try another bind with the same password.
   */
  private async bindThenLoad(
    client: LdapSession,
    bindName: string,
    password: string,
    username: string,
  ) {
    try {
      await client.bind(bindName, password);
    } catch {
      return null;
    }
    const dn = await this.searchUniqueDn(client, username, true);
    if (dn === "ambiguous" || !dn) return "invalid";
    const loaded = await this.loadEntry(client, dn, username);
    return loaded ?? { dn, username, claims: {}, memberOf: [] };
  }

  private async searchUniqueDn(
    client: LdapSession,
    username: string,
    preferServiceBind: boolean,
  ): Promise<string | "ambiguous" | null> {
    if (!this.config.userSearchBase) return null;
    if (preferServiceBind && this.config.bindDn && this.config.bindPassword) {
      await client.bind(this.config.bindDn, this.config.bindPassword);
    } else if (preferServiceBind && (!this.config.bindDn || !this.config.bindPassword)) {
      if (this.config.bindDn || this.config.bindPassword) return null;
    }
    const { searchEntries } = await client.search(this.config.userSearchBase, {
      scope: "sub",
      filter: userFilter(this.config, username),
      attributes: ["uid"],
      sizeLimit: 2,
    });
    if (searchEntries.length > 1) return "ambiguous";
    const first = searchEntries[0];
    const dn = first && typeof first.dn === "string" ? first.dn : "";
    return dn.length > 0 ? dn : null;
  }

  private async loadEntry(
    client: LdapSession,
    dn: string,
    fallbackUsername: string,
  ) {
    let entry = await this.readEntry(client, dn);
    if (!entry && this.config.bindDn && this.config.bindPassword) {
      await client.bind(this.config.bindDn, this.config.bindPassword);
      entry = await this.readEntry(client, dn);
    }
    if (!entry) return null;
    const username =
      firstDirectoryString(entry.uid) ??
      firstDirectoryString(entry.sAMAccountName) ??
      fallbackUsername;
    const memberOf = this.config.memberAttribute
      ? directoryStrings(entry[this.config.memberAttribute] ?? entry.memberOf)
      : directoryStrings(entry.memberOf);
    return {
      dn,
      username,
      claims: claimsFromEntry(entry),
      memberOf,
    };
  }

  private async readEntry(
    client: LdapSession,
    dn: string,
  ): Promise<(Record<string, unknown> & { dn: string }) | null> {
    try {
      const { searchEntries } = await client.search(dn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: claimAttributes(this.config),
        sizeLimit: 1,
      });
      return searchEntries[0] ?? null;
    } catch {
      if (!this.config.userSearchBase) return null;
      const { searchEntries } = await client.search(this.config.userSearchBase, {
        scope: "sub",
        filter: `(entryDN=${escapeFilter(dn)})`,
        attributes: claimAttributes(this.config),
        sizeLimit: 1,
      });
      return searchEntries[0] ?? null;
    }
  }

  private async collectGroups(
    client: LdapSession,
    dn: string,
    memberOf: readonly string[],
  ): Promise<string[]> {
    const fromAttr = normalizeGroupDns(memberOf, LDAP_MAX_GROUPS);
    let fromSearch: string[] = [];
    try {
      fromSearch = await this.searchGroups(client, dn);
    } catch (err) {
      if (!(err instanceof LdapUnavailableError)) throw err;
    }
    return normalizeGroupDns([...fromAttr, ...fromSearch], LDAP_MAX_GROUPS);
  }

  private async searchGroups(client: LdapSession, dn: string): Promise<string[]> {
    if (!this.config.groupSearchBase) return [];
    // User bind already proved the password. osixia (and many directories)
    // hide ou=groups from non-admin binds as LDAP 0x20 No Such Object.
    // Optional service-bind is the existing #885 seam for that lookup.
    if (this.config.bindDn && this.config.bindPassword) {
      await client.bind(this.config.bindDn, this.config.bindPassword);
    }
    const filter = interpolate(this.config.groupSearchFilter, {
      dn: escapeFilter(dn),
    });
    const { searchEntries } = await client.search(this.config.groupSearchBase, {
      scope: "sub",
      filter,
      attributes: ["cn"],
      sizeLimit: LDAP_MAX_GROUPS,
    });
    return searchEntries
      .map((entry) => (typeof entry.dn === "string" ? entry.dn : ""))
      .filter((value) => value.length > 0);
  }

  private mapClaims(
    claims: Record<string, string>,
  ): Partial<Record<DirectoryMappedField, string>> | undefined {
    try {
      const mapped = mapDirectoryClaimsToProfileFields(claims, this.config.attributeMap);
      return mapped.fields;
    } catch {
      throw new DirectoryClaimsUnsafeError();
    }
  }
}

function directoryUserSearchBase(config: LdapConfig): string | null {
  if (config.userSearchBase) return config.userSearchBase;
  const template = config.userDnTemplate;
  const marker = "{username},";
  if (!template) return null;
  const markerIndex = template.indexOf(marker);
  if (markerIndex < 0) return null;
  const base = template.slice(markerIndex + marker.length);
  return base && !base.includes("{") && !base.includes("}") ? base : null;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(20, Math.trunc(limit)));
}

async function safeUnbind(client: LdapSession): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // ignore cleanup failures; the primary operation remains authoritative
  }
}
