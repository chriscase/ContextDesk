import {
  ADMIN_AUDIT_LIST_SCHEMA_ID,
  ADMIN_AUDIT_MAX_RESULTS,
  parseAdminAuditList,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { AuditStore } from "./store.js";

export interface AdminAuditRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
}

export async function registerAdminAuditRoutes(
  app: FastifyInstance,
  deps: AdminAuditRouteDeps,
): Promise<void> {
  app.get("/api/admin/audit", async (request: FastifyRequest, reply) => {
    const loaded = await requireSessionCapability(
      request,
      reply,
      deps.sessionAuth,
      "audit:view",
    );
    if ("denied" in loaded) return loaded.denied;
    try {
      const events = await deps.audit.list();
      const truncated = events.length > ADMIN_AUDIT_MAX_RESULTS;
      const body = parseAdminAuditList({
        schemaId: ADMIN_AUDIT_LIST_SCHEMA_ID,
        events: events.slice(0, ADMIN_AUDIT_MAX_RESULTS).map((row) => ({
          at: row.at.toISOString(),
          identity: row.identity,
          action: row.action,
          target: row.target,
          outcome: row.outcome,
        })),
        limit: ADMIN_AUDIT_MAX_RESULTS,
        truncated,
      });
      return body;
    } catch {
      void reply.code(503);
      return { error: "unavailable" };
    }
  });
}
