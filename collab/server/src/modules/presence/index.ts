/** Ephemeral authenticated presence for a case's collaborative room. */
export const MODULE_ID = "presence" as const;

export { MemoryPresenceBackend, PgPresenceBackend, PresenceService } from "./service.js";
export type {
  CasePresenceRecord,
  OverviewPresenceQuery,
  PresenceActor,
  PresenceBackend,
  PresenceRecord,
} from "./service.js";
export { registerPresenceRoutes } from "./routes.js";
export type { PresenceRouteDeps } from "./routes.js";
