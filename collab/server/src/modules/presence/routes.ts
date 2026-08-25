import {
  PRESENCE_SURFACES,
  type PresenceSurface,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import { PresenceService } from "./service.js";

export interface PresenceRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  cases: CaseService;
  presence: PresenceService;
}

export async function registerPresenceRoutes(
  app: FastifyInstance,
  deps: PresenceRouteDeps,
): Promise<void> {
  async function caseAccess(caseId: string, request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    const loaded = await requireSessionCapability(
      request,
      reply,
      deps.sessionAuth,
      "investigation:read",
    );
    if ("denied" in loaded) return loaded;
    if (!(await deps.cases.getCase(caseId, loaded.ctx.actor, loaded.ctx.isAdmin))) {
      void reply.code(404);
      return { denied: { error: "not_found" } };
    }
    return loaded;
  }

  app.get("/api/cases/:id/presence", async (request, reply) => {
    const caseId = (request.params as { id: string }).id;
    const loaded = await caseAccess(caseId, request, reply);
    if ("denied" in loaded) return loaded.denied;
    return await deps.presence.list(caseId);
  });

  app.post("/api/cases/:id/presence", async (request, reply) => {
    const caseId = (request.params as { id: string }).id;
    const loaded = await caseAccess(caseId, request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
