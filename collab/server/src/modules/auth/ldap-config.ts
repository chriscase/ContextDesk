/**
 * LDAP transport config. Plaintext is refused at load time.
 * Service-bind password, if present, stays in this module — never in generic Config.
 */

export interface LdapConfig {
  url: string;
  starttls: boolean;
  verifyTls: boolean;
  ca: string | undefined;
  userDnTemplate: string | undefined;
  userSearchBase: string | undefined;
  userSearchFilter: string;
  groupSearchBase: string | undefined;
  groupSearchFilter: string;
  bindDn: string | undefined;
  /** Memory-only; never logged. */
  bindPassword: string | undefined;
  timeoutMs: number;
}

export function loadLdapConfig(
  env: NodeJS.ProcessEnv = process.env,
): LdapConfig {
  const url = env.COLLAB_LDAP_URL;
  if (!url) {
    throw new Error("missing COLLAB_LDAP_URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("COLLAB_LDAP_URL is not a valid URL");
  }
  const starttls = env.COLLAB_LDAP_STARTTLS === "1";
  if (parsed.protocol === "ldap:" && !starttls) {
    throw new Error(
      "plaintext LDAP refused: use ldaps:// or ldap:// with COLLAB_LDAP_STARTTLS=1",
    );
  }
  if (parsed.protocol !== "ldaps:" && parsed.protocol !== "ldap:") {
    throw new Error(`unsupported LDAP URL scheme: ${parsed.protocol}`);
  }
  const insecure = env.COLLAB_LDAP_TLS_INSECURE === "1";
  const devMode = env.COLLAB_LDAP_DEV_MODE === "1";
  if (insecure && !devMode) {
    throw new Error(
      "COLLAB_LDAP_TLS_INSECURE requires explicit COLLAB_LDAP_DEV_MODE=1",
    );
  }
  return {
    url,
    starttls,
    verifyTls: !insecure,
    ca: env.COLLAB_LDAP_CA,
    userDnTemplate: env.COLLAB_LDAP_USER_DN_TEMPLATE,
    userSearchBase: env.COLLAB_LDAP_USER_SEARCH_BASE,
    userSearchFilter: env.COLLAB_LDAP_USER_SEARCH_FILTER ?? "(uid={username})",
    groupSearchBase: env.COLLAB_LDAP_GROUP_SEARCH_BASE,
    groupSearchFilter:
      env.COLLAB_LDAP_GROUP_SEARCH_FILTER ??
      "(&(objectClass=groupOfNames)(member={dn}))",
    bindDn: env.COLLAB_LDAP_BIND_DN,
    bindPassword: env.COLLAB_LDAP_BIND_PASSWORD,
    timeoutMs: Number.parseInt(env.COLLAB_LDAP_TIMEOUT_MS ?? "8000", 10) || 8000,
  };
}
