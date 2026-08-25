import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { PresenceService } from "../presence/index.js";
import type { TriageRunService } from "../triage-runs/index.js";
import { OverviewService } from "./service.js";

export interface OverviewRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  cases: CaseService;
  experiments: ExperimentService;
  triageRuns: TriageRunService;
  presence: PresenceService;
}

export async function registerOverviewRoutes(
  app: FastifyInstance,
  deps: OverviewRouteDeps,
): Promise<void> {
  const overview = new OverviewService({
    cases: deps.cases,
    experiments: deps.experiments,
    triageRuns: deps.triageRuns,
    presence: deps.presence,
  });

  app.get("/api/overview", async (request: FastifyRequest, reply) => {
    const loaded = await requireSessionCapability(
      request,
      reply,
      deps.sessionAuth,
      "investigation:read",
    );
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    return overview.get({
      id: ctx.identity.id,
      username: ctx.identity.username,
      displayName: ctx.identity.displayName,
      roles: ctx.roles,
      isAdmin: ctx.isAdmin,
      canLead: ctx.has("decision:accept"),
      canMutate: ctx.has("investigation:write"),
    });
  });
}
