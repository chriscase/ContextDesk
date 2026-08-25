import { Client } from "ldapts";
import { ldapClientOptions, ldapTlsOptions } from "./ldap-tls.js";
import type { LdapConfig } from "./ldap-config.js";
import {
  LdapBindError,
  LdapTimeoutError,
  LdapTlsError,
  LdapUnavailableError,
  type LdapSearchOptions,
  type LdapSearchResult,
  type LdapSession,
  type LdapSessionFactory,
} from "./ldap-session.js";

function classifyLdapError(err: unknown): never {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : "LDAP error";
  if (/timeout|time.?out/i.test(message)) throw new LdapTimeoutError();
  if (/cert|tls|ssl|self-signed|unable to verify|untrusted/i.test(message)) {
    throw new LdapTlsError(message.slice(0, 160));
  }
  if (/no such object|insufficient access|0x20/i.test(message)) {
    throw new LdapUnavailableError(message.slice(0, 160));
  }
  if (/invalid credentials|inappropriate auth|bind/i.test(message)) {
    throw new LdapBindError();
  }
  throw err instanceof Error ? err : new Error(message);
}

export function createLiveLdapFactory(config: LdapConfig): LdapSessionFactory {
  return () => {
    const client = new Client(ldapClientOptions(config));
    const session: LdapSession = {
      async startTLS() {
        try {
          await client.startTLS(ldapTlsOptions(config));
        } catch (err) {
          classifyLdapError(err);
        }
      },
      async handshake() {
        if (config.starttls) {
          try {
            await client.startTLS(ldapTlsOptions(config));
          } catch (err) {
            classifyLdapError(err);
          }
          return;
        }
        // LDAPS: force the TLS socket without treating a refused anonymous
        // Root DSE search as a transport failure.
        try {
          await client.search("", {
            scope: "base",
            filter: "(objectClass=*)",
            attributes: ["objectClass"],
            sizeLimit: 1,
          });
        } catch (err) {
          const message = err instanceof Error ? `${err.name}: ${err.message}` : "";
          if (/timeout|time.?out|cert|tls|ssl|self-signed|unable to verify|untrusted/i.test(message)) {
            classifyLdapError(err);
          }
        }
      },
      async bind(dn, password) {
        try {
          await client.bind(dn, password);
        } catch (err) {
          classifyLdapError(err);
        }
      },
      async search(base, options: LdapSearchOptions): Promise<LdapSearchResult> {
        try {
          const { searchEntries } = await client.search(base, {
            scope: options.scope,
            filter: options.filter,
            attributes: options.attributes,
            sizeLimit: options.sizeLimit,
          });
          return {
            searchEntries: searchEntries.map((entry) => ({
              ...entry,
              dn: typeof entry.dn === "string" ? entry.dn : "",
            })),
          };
        } catch (err) {
          classifyLdapError(err);
        }
      },
      async unbind() {
        try {
          await client.unbind();
        } catch {
          // ignore cleanup failures
        }
      },
    };
    return session;
  };
}
