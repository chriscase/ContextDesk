/** Append-only audit history. Metadata only — never passwords or upload bodies. */
export const MODULE_ID = "audit" as const;

export {
  MemoryAuditStore,
  PgAuditStore,
} from "./store.js";
export type { AuditOutcome, AuditRecord, AuditStore, StoredAudit } from "./store.js";
export { registerAdminAuditRoutes } from "./routes.js";
export type { AdminAuditRouteDeps } from "./routes.js";
