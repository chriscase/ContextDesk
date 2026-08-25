import { AUTH_ERROR_SCHEMA_ID, type AuthErrorV1 } from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import {
  InvestigationActivityError,
  InvestigationActivityService,
  investigationActivityErrorBody,
  parseInvestigationActivityQueryFilter,
  type InvestigationActivityListInput,
} from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function asQuery(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null && !Array.isArray(query)
    ? (query as Record<string, unknown>)
    : {};
}

export interface InvestigationActivityRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  domain: CaseService;
  installationId: string;
}

export async function registerInvestigationActivityRoutes(
  app: FastifyInstance,
  deps: InvestigationActivityRouteDeps,
): Promise<void> {
  const activity = new InvestigationActivityService({
    cases: deps.domain,
    installationId: deps.installationId,
  });

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

  function replyActivityError(
    reply: { code: (status: number) => unknown },
    error: unknown,
  ): AuthErrorV1 | ReturnType<typeof investigationActivityErrorBody> {
    if (error instanceof InvestigationActivityError) {
      void reply.code(error.code === "not_found" ? 404 : 400);
      return error.toJSON();
    }
    void reply.code(400);
    return investigationActivityErrorBody("invalid_filter");
  }

  function listInput(
    ctx: { actor: { id: string; username: string }; isAdmin: boolean },
    query: Record<string, unknown>,
    caseId?: string,
  ): InvestigationActivityListInput {
    const filter = parseInvestigationActivityQueryFilter(query);
    const rawLimit = query.limit;
    const limit = typeof rawLimit === "string"
      ? Number.parseInt(rawLimit, 10)
      : typeof rawLimit === "number" ? rawLimit : undefined;
    const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
    return {
      actor: ctx.actor,
      isAdmin: ctx.isAdmin,
      filter: caseId ? { ...filter, investigationId: caseId } : filter,
      ...(caseId ? { caseId } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
  }

  app.get("/api/investigation-activity", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    try {
      return await activity.listPage(listInput(ctx, asQuery(request.query)));
    } catch (error) {
      return replyActivityError(reply, error);
    }
  });

  app.get("/api/cases/:id/investigation-activity", async (request, reply) => {
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
    const query = asQuery(request.query);
    try {
      const filter = parseInvestigationActivityQueryFilter(query);
      if (filter.investigationId && filter.investigationId !== caseId) {
        throw new InvestigationActivityError("invalid_filter");
      }
      return await activity.listPage(listInput(ctx, query, caseId));
    } catch (error) {
      return replyActivityError(reply, error);
    }
  });

  app.get("/api/investigation-resources/resolve", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const locator = asQuery(request.query).locator;
    if (typeof locator !== "string" || locator.length < 1) {
      void reply.code(400);
      return investigationActivityErrorBody("invalid_locator");
    }
    try {
      return await activity.resolve(ctx.actor, ctx.isAdmin, locator);
    } catch (error) {
      return replyActivityError(reply, error);
    }
  });
}
