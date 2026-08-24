import { AUTH_ERROR_SCHEMA_ID, type AuthErrorV1 } from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { PresenceService } from "../presence/index.js";
import type { TriageRunService } from "../triage-runs/index.js";
import { OverviewService } from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

export interface OverviewRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
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
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const roles = deps.roles.resolve(session.groups);
    if (!canPerform(roles, "read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    return overview.get({
      id: session.identity.id,
      username: session.identity.username,
      displayName: session.identity.displayName,
      roles,
      isAdmin: canPerform(roles, "admin"),
      canLead: canPerform(roles, "lead"),
      canMutate: canPerform(roles, "mutate"),
    });
  });
}
