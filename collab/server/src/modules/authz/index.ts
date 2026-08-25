/** Group→role authorization. Roles are recomputed from the current map each request. */
export const MODULE_ID = "authz" as const;

export {
  APP_ROLES,
  MutableGroupRoleMap,
  canPerform,
  emptyMapping,
  isAppRole,
  parseGroupRoleMap,
  resolveRoles,
} from "./roles.js";
export type { AppRole, AuthzAction, GroupRoleMapping } from "./roles.js";
export { registerAuthzRoutes } from "./routes.js";
export type { AuthzRouteDeps } from "./routes.js";
export { MemoryGroupRoleStore, PgGroupRoleStore } from "./store.js";
export type { GroupRoleStore } from "./store.js";
export {
  authorizeSession,
  capabilityForbidden,
  requireSessionCapability,
  sessionAuthFailure,
  sessionCapabilityFlags,
} from "./session-authorization.js";
export type {
  AuthorizedSession,
  SessionAuthResult,
  SessionAuthorizationDeps,
  SessionGrantLookup,
  SessionProfileLookup,
} from "./session-authorization.js";
