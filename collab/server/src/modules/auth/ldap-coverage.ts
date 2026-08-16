/**
 * Live OpenLDAP tests skip when the directory is absent locally.
 * Hosted CI must set COLLAB_REQUIRE_LDAP=1 so a missing URL fails closed
 * instead of silently dropping the encrypted-bind coverage.
 */
export const REQUIRED_LIVE_LDAP_ENV = [
  "COLLAB_LDAP_URL",
  "COLLAB_LDAP_STARTTLS",
  "COLLAB_LDAP_BIND_DN",
  "COLLAB_LDAP_BIND_PASSWORD",
  "COLLAB_LDAP_USER_DN_TEMPLATE",
  "COLLAB_LDAP_GROUP_SEARCH_BASE",
] as const;

export function liveLdapConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const required = env.COLLAB_REQUIRE_LDAP === "1";
  const url = env.COLLAB_LDAP_URL?.trim();
  if (required && !url) {
    throw new Error("COLLAB_REQUIRE_LDAP=1 but COLLAB_LDAP_URL is missing");
  }
  return Boolean(url);
}

export function missingRequiredLiveLdapEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REQUIRED_LIVE_LDAP_ENV.filter((name) => !env[name]?.trim());
}
