import type { ConnectionOptions } from "node:tls";
import { type ClientOptions } from "ldapts";
import type { LdapConfig } from "./ldap-config.js";

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
