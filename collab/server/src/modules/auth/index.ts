/**
 * Authentication module. Passwords exist only inside this module, in memory,
 * for the duration of a directory bind. No hashing, caching, or logging.
 */
export const MODULE_ID = "auth" as const;

export type { AuthAdapter, AuthIdentity, AuthSuccess } from "./adapter.js";
export { MapAuthAdapter } from "./adapter.js";
export { LdapAuthAdapter, ldapClientOptions, ldapTlsOptions } from "./ldap-adapter.js";
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
export type { AuthRouteDeps } from "./routes.js";
