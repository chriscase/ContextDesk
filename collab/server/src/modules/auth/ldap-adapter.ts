import { Client, type ClientOptions } from "ldapts";
import type { AuthAdapter, AuthSuccess } from "./adapter.js";
import type { LdapConfig } from "./ldap-config.js";
import type { AuthLog } from "./log.js";

function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\${hex}`;
  });
}

function interpolate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
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
    const client = new Client(this.clientOptions());
    try {
      if (this.config.starttls) {
        await client.startTLS({
          rejectUnauthorized: this.config.verifyTls,
          ca: this.config.ca,
        });
      }
      const dn = await this.resolveUserDn(client, username, password);
      if (!dn) {
        this.log.event({ event: "ldap_bind_failed", username });
        return null;
      }
      await client.bind(dn, password);
      const groups = await this.searchGroups(client, dn);
      this.log.event({ event: "ldap_bind_ok", username });
      return {
        identity: { id: dn, username, displayName: username },
        groups,
      };
    } catch {
      this.log.event({ event: "ldap_bind_failed", username });
      return null;
    } finally {
      try {
        await client.unbind();
      } catch {
        // ignore
      }
    }
  }

  private clientOptions(): ClientOptions {
    return {
      url: this.config.url,
      timeout: this.config.timeoutMs,
      connectTimeout: this.config.timeoutMs,
      tlsOptions: {
        rejectUnauthorized: this.config.verifyTls,
        ca: this.config.ca,
      },
    };
  }

  private async resolveUserDn(
    client: Client,
    username: string,
    password: string,
  ): Promise<string | null> {
    if (this.config.userDnTemplate) {
      return interpolate(this.config.userDnTemplate, {
        username: escapeFilter(username),
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
      attributes: ["dn"],
      sizeLimit: 2,
    });
    const first = searchEntries[0];
    if (!first || searchEntries.length !== 1) return null;
    const dn = first.dn;
    return typeof dn === "string" ? dn : null;
  }

  private async searchGroups(client: Client, dn: string): Promise<string[]> {
    if (!this.config.groupSearchBase) return [];
    const filter = interpolate(this.config.groupSearchFilter, {
      dn: escapeFilter(dn),
    });
    const { searchEntries } = await client.search(this.config.groupSearchBase, {
      scope: "sub",
      filter,
      attributes: ["dn"],
      sizeLimit: 50,
    });
    return searchEntries
      .map((e) => (typeof e.dn === "string" ? e.dn : ""))
      .filter((v) => v.length > 0);
  }
}
