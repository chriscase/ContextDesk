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
export { loadLdapConfig } from "./ldap-config.js";
export type { LdapConfig } from "./ldap-config.js";
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
