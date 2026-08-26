/**
 * Authentication module. Passwords exist only inside this module, in memory,
 * for the duration of a directory bind or local compare. No caching, logging,
 * or retained derived secrets. MapAuthAdapter may hash ephemerally to feed
 * timingSafeEqual a fixed-length buffer.
 */
export const MODULE_ID = "auth" as const;

export type {
  AuthAdapter,
  AuthIdentity,
  AuthSuccess,
  DirectorySearchOptions,
} from "./adapter.js";
export { MapAuthAdapter } from "./adapter.js";
export { loadLocalAuthAdapter } from "./local-adapter.js";
export {
  LdapAuthAdapter,
  directoryGroupFilter,
  directoryIdentityFilter,
  ldapClientOptions,
  ldapTlsOptions,
} from "./ldap-adapter.js";
export { ldapConfigFromSetup, loadLdapConfig, publicLdapConfig } from "./ldap-config.js";
export type { LdapConfig } from "./ldap-config.js";
export { probeLdap } from "./ldap-probe.js";
export type { LdapProbeInput } from "./ldap-probe.js";
export {
  DirectoryClaimsUnsafeError,
  LdapBindError,
  LdapTimeoutError,
  LdapTlsError,
  LdapUnavailableError,
} from "./ldap-session.js";
export type { LdapSession, LdapSessionFactory } from "./ldap-session.js";
export { createSyntheticLdapFactory, exampleSyntheticDirectory } from "./ldap-synthetic.js";
export type { SyntheticDirectoryOptions } from "./ldap-synthetic.js";
export { parseLoginName } from "./ldap-resolution.js";
export { createAuthLog } from "./log.js";
export type { AuthLog, AuthLogEvent } from "./log.js";
export { createRateLimiter } from "./rate-limit.js";
export type { RateLimiter } from "./rate-limit.js";
export {
  MemorySessionStore,
  PgSessionStore,
  defaultSessionPolicy,
  isSessionActive,
} from "./sessions.js";
export type { SessionPolicy, SessionRecord, SessionStore } from "./sessions.js";
export {
  SESSION_COOKIE,
  registerAuthRoutes,
  resolveActiveSession,
} from "./routes.js";
export type { ActiveSessionDeps, AuthRouteDeps } from "./routes.js";
export {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  hasCsrfHeader,
  hasSessionCookieHeader,
  injectWithoutBrowserCsrf,
  registerBrowserMutationCsrfGuard,
} from "./csrf.js";
export { escapeDn, escapeFilter } from "./ldap-escape.js";
export { liveLdapConfigured } from "./ldap-coverage.js";
export {
  HmacPublicIdentityCodec,
  createEphemeralPublicIdentityCodec,
  loadPublicIdentityCodec,
} from "./public-identity.js";
export type { PublicIdentityCodec } from "./public-identity.js";
