import {
  AUTH_ERROR_SCHEMA_ID,
  TRIAGE_JOB_LIST_SCHEMA_ID,
  parseTriageJobRequest,
  projectTriageJobShareSafe,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import { TriageRunConflictError, TriageRunNotFoundError, TriageRunService } from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

export interface TriageRunRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  runs: TriageRunService;
}

export async function registerTriageRunRoutes(
  app: FastifyInstance,
  deps: TriageRunRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
      canLead: canPerform(roles, "lead"),
    };
  }

  function fail(reply: { code: (status: number) => unknown }, error: unknown): { error: string } {
    if (error instanceof TriageRunNotFoundError) {
      void reply.code(404);
      return { error: "not_found" };
    }
    if (error instanceof TriageRunConflictError) {
      void reply.code(409);
      return { error: error.message };
    }
    void reply.code(400);
    return { error: error instanceof Error ? error.message : "invalid" };
  }

  app.get("/api/triage-profiles", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    return {
      schemaId: "cd-collab.triage_profile_list.v1",
      profiles: deps.runs.listProfiles(),
    };
  });

  app.get("/api/triage-capabilities", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    return deps.runs.capabilities();
  });

  app.get("/api/cases/:id/triage-runs", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const caseId = (request.params as { id: string }).id;
    return {
      schemaId: TRIAGE_JOB_LIST_SCHEMA_ID,
      caseId,
      jobs: await deps.runs.list(caseId, ctx.actor, ctx.isAdmin),
    };
  });

  app.get("/api/cases/:id/triage-runs/:jid", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; jid: string };
    const job = await deps.runs.get(params.id, params.jid, ctx.actor, ctx.isAdmin);
    if (!job) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return job;
  });

  app.get("/api/cases/:id/triage-runs/:jid/share-safe", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; jid: string };
    const job = await deps.runs.get(params.id, params.jid, ctx.actor, ctx.isAdmin);
    if (!job) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return projectTriageJobShareSafe(job);
  });

  app.post("/api/cases/:id/triage-runs", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const caseId = (request.params as { id: string }).id;
    try {
      const parsed = parseTriageJobRequest(request.body);
      return await deps.runs.create(caseId, ctx.actor, parsed, request.ip, ctx.isAdmin);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/cases/:id/triage-runs/:jid/cancel", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; jid: string };
    try {
      return await deps.runs.cancel(params.id, params.jid, ctx.actor, request.ip, ctx.isAdmin);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
