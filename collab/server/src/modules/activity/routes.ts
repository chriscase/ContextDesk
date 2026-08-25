import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PublicIdentityCodec } from "../auth/index.js";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { CaseService } from "../cases/index.js";
import {
  InvestigationActivityError,
  InvestigationActivityService,
  investigationActivityErrorBody,
  parseInvestigationActivityQueryFilter,
  type InvestigationActivityListInput,
} from "./service.js";

function asQuery(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null && !Array.isArray(query)
    ? (query as Record<string, unknown>)
    : {};
}

export interface InvestigationActivityRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  domain: CaseService;
  installationId: string;
  publicIdentities?: PublicIdentityCodec;
}

export async function registerInvestigationActivityRoutes(
  app: FastifyInstance,
  deps: InvestigationActivityRouteDeps,
): Promise<void> {
  const activity = new InvestigationActivityService({
    cases: deps.domain,
    installationId: deps.installationId,
    ...(deps.publicIdentities
      ? { publicIdentityId: (raw: string) => deps.publicIdentities!.publicId(raw) }
      : {}),
  });

  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth, "investigation:read");
  }

  function replyActivityError(
    reply: { code: (status: number) => unknown },
    error: unknown,
  ): ReturnType<typeof investigationActivityErrorBody> {
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    try {
      return await activity.listPage(listInput(ctx, asQuery(request.query)));
    } catch (error) {
      return replyActivityError(reply, error);
    }
  });

  app.get("/api/cases/:id/investigation-activity", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
