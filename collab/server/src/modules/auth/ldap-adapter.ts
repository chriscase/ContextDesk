import type { ConnectionOptions } from "node:tls";
import { Client, type ClientOptions } from "ldapts";
import type { AuthAdapter, AuthIdentity, AuthSuccess } from "./adapter.js";
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
