import type { ConnectionOptions } from "node:tls";
import { Client, type ClientOptions } from "ldapts";
import type {
  AuthAdapter,
  AuthIdentity,
  AuthSuccess,
  DirectorySearchOptions,
} from "./adapter.js";
import type { LdapConfig } from "./ldap-config.js";
import { escapeDn, escapeFilter, interpolate } from "./ldap-escape.js";
import type { AuthLog } from "./log.js";

export { escapeDn, escapeFilter } from "./ldap-escape.js";

function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  return `${err.name}: ${err.message}`.slice(0, 160);
}

/**
 * TLS options for LDAPS connect or StartTLS upgrade.
 * Do not pass `ca: undefined` — Node treats that as an empty trust store.
 * osixia fixture certs need an explicit ECDH curve for Node 22.
 */
export function ldapTlsOptions(config: LdapConfig): ConnectionOptions {
  const options: ConnectionOptions = {
    rejectUnauthorized: config.verifyTls,
  };
  if (config.ca !== undefined) {
    options.ca = config.ca;
  }
  if (!config.verifyTls) {
    options.ecdhCurve = "auto";
  }
  return options;
}

/**
 * ldapts treats any constructor `tlsOptions` as "TLS from the first byte".
 * StartTLS must connect plaintext, then upgrade — so omit tlsOptions there.
 */
export function ldapClientOptions(config: LdapConfig): ClientOptions {
  const options: ClientOptions = {
    url: config.url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
  };
  if (!config.starttls) {
    options.tlsOptions = ldapTlsOptions(config);
  }
  return options;
}

export function directoryIdentityFilter(term: string): string {
  const escaped = escapeFilter(term);
  return `(&(objectClass=person)(|(uid=${escaped}*)(cn=${escaped}*)(displayName=${escaped}*)))`;
}

export function directoryGroupFilter(term: string): string {
  return `(&(objectClass=groupOfNames)(cn=${escapeFilter(term)}*))`;
}

export class LdapAuthAdapter implements AuthAdapter {
  constructor(
    private readonly config: LdapConfig,
    private readonly log: AuthLog,
  ) {}

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthSuccess | null> {
    if (!username || !password) return null;
    const client = new Client(ldapClientOptions(this.config));
    try {
      if (this.config.starttls) {
        await client.startTLS(ldapTlsOptions(this.config));
      }
      const dn = await this.resolveUserDn(client, username, password);
      if (!dn) {
        this.log.event({ event: "ldap_bind_failed", username, detail: "no_dn" });
        return null;
      }
      await client.bind(dn, password);
      const groups = await this.searchGroups(client, dn);
      this.log.event({ event: "ldap_bind_ok", username });
      return {
        identity: { id: dn, username, displayName: username },
        groups,
      };
    } catch (err) {
      this.log.event({ event: "ldap_bind_failed", username, detail: errorDetail(err) });
      return null;
    } finally {
      try {
        await client.unbind();
      } catch {
        // ignore
      }
    }
  }

  async lookupGroups(identity: AuthIdentity): Promise<string[]> {
    const client = new Client(ldapClientOptions(this.config));
    try {
      if (this.config.starttls) {
        await client.startTLS(ldapTlsOptions(this.config));
      }
      return await this.searchGroups(client, identity.id);
    } finally {
      try {
        await client.unbind();
      } catch {
        // ignore
      }
    }
  }

  async searchIdentities(
    term: string,
    options: DirectorySearchOptions,
  ) {
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
          const username = firstString(entry.uid);
          const displayName =
            firstString(entry.displayName) ?? firstString(entry.cn) ?? username;
          if (!id || !username || !displayName) return null;
          return { id, username, displayName, source: "ldap" as const };
        })
        .filter((entry) => entry !== null)
        .sort((a, b) =>
          a.username.localeCompare(b.username) || a.id.localeCompare(b.id),
        )
        .slice(0, boundedLimit(options.limit));
    } finally {
      await safeUnbind(client);
    }
  }

  async searchDirectoryGroups(
    term: string,
    options: DirectorySearchOptions,
  ) {
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
          const name = firstString(entry.cn);
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

  private directoryClient(timeoutMs: number): Client {
    const boundedTimeout = Math.max(100, Math.min(this.config.timeoutMs, timeoutMs));
    return new Client(ldapClientOptions({ ...this.config, timeoutMs: boundedTimeout }));
  }

  private async startDirectorySession(client: Client): Promise<void> {
    if (!this.config.bindDn || !this.config.bindPassword) {
      throw new Error("LDAP directory search requires service bind");
    }
    if (this.config.starttls) {
      await client.startTLS(ldapTlsOptions(this.config));
    }
    await client.bind(this.config.bindDn, this.config.bindPassword);
  }

  private async resolveUserDn(
    client: Client,
    username: string,
    password: string,
  ): Promise<string | null> {
    if (this.config.userDnTemplate) {
      return interpolate(this.config.userDnTemplate, {
        username: escapeDn(username),
      });
    }
    if (!this.config.userSearchBase) {
      throw new Error("LDAP user DN template or search base is required");
    }
    if (this.config.bindDn && this.config.bindPassword) {
      await client.bind(this.config.bindDn, this.config.bindPassword);
    } else {
      // Anonymous search, then user bind. Password unused until user bind.
      void password;
    }
    const filter = interpolate(this.config.userSearchFilter, {
      username: escapeFilter(username),
    });
    const { searchEntries } = await client.search(this.config.userSearchBase, {
      scope: "sub",
      filter,
      // `dn` is not a schema attribute; requesting it can fail the search.
      attributes: ["uid"],
      sizeLimit: 2,
    });
    const first = searchEntries[0];
    if (!first || searchEntries.length !== 1) return null;
    const dn = first.dn;
    return typeof dn === "string" && dn.length > 0 ? dn : null;
  }

  private async searchGroups(client: Client, dn: string): Promise<string[]> {
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
      sizeLimit: 50,
    });
    return searchEntries
      .map((e) => (typeof e.dn === "string" ? e.dn : ""))
      .filter((v) => v.length > 0);
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

function firstString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0 ? first : null;
}

async function safeUnbind(client: Client): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // ignore cleanup failures; the primary operation remains authoritative
  }
}
