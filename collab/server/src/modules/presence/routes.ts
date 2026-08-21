import {
  PRESENCE_SURFACES,
  type PresenceSurface,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import { PresenceService } from "./service.js";

export interface PresenceRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  cases: CaseService;
  presence: PresenceService;
}

export async function registerPresenceRoutes(
  app: FastifyInstance,
  deps: PresenceRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
    };
  }

  async function caseAccess(caseId: string, request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return null;
    }
    if (!ctx.canRead || !(await deps.cases.getCase(caseId, ctx.actor, ctx.isAdmin))) {
      void reply.code(404);
      return null;
    }
    return ctx;
  }

  app.get("/api/cases/:id/presence", async (request, reply) => {
    const caseId = (request.params as { id: string }).id;
    const ctx = await caseAccess(caseId, request, reply);
    if (!ctx) return { error: "not_found" };
    return await deps.presence.list(caseId);
  });

  app.post("/api/cases/:id/presence", async (request, reply) => {
    const caseId = (request.params as { id: string }).id;
    const ctx = await caseAccess(caseId, request, reply);
    if (!ctx) return { error: "not_found" };
    const surface = typeof (request.body as { surface?: unknown } | null)?.surface === "string"
      ? (request.body as { surface: string }).surface
      : "experiment_lab";
    if (!(PRESENCE_SURFACES as readonly string[]).includes(surface)) {
      void reply.code(400);
      return { error: "invalid presence surface" };
    }
    await deps.presence.touch(caseId, ctx.actor, surface as PresenceSurface);
    return await deps.presence.list(caseId);
  });
}
