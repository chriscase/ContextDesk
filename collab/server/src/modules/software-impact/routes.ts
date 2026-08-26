import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import {
  DuplicateSoftwareImpactError,
  InvestigationNotVisibleError,
  SoftwareImpactNotFoundError,
  SoftwareImpactReleasedError,
  type SoftwareImpactService,
} from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function domainError(
  reply: { code: (status: number) => unknown },
  error: unknown,
): { error: string; detail?: string; existingId?: string } {
  if (error instanceof InvestigationNotVisibleError || error instanceof SoftwareImpactNotFoundError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof SoftwareImpactReleasedError) {
    void reply.code(409);
    return { error: "already_released" };
  }
  if (error instanceof DuplicateSoftwareImpactError) {
    void reply.code(409);
    return { error: "already_recorded", existingId: error.existingId };
  }
  if (error instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${error.path}: ${error.detail}` };
  }
  void reply.code(400);
  return { error: "invalid", detail: error instanceof Error ? error.message : "invalid" };
}

export interface SoftwareImpactRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  softwareImpact: SoftwareImpactService;
  visibleInvestigationIds: (actor: { id: string; username: string }, isAdmin: boolean)
    => Promise<string[]>;
}

export async function registerSoftwareImpactRoutes(
  app: FastifyInstance,
  deps: SoftwareImpactRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/software-impact/suggestions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const field = str((request.query as Record<string, unknown>).field);
    if (!field) {
      void reply.code(400);
      return { error: "invalid", detail: "$.field: missing required key" };
    }
    try {
      const visible = await deps.visibleInvestigationIds(ctx.actor, ctx.isAdmin);
      return await deps.softwareImpact.suggestions(field, ctx.actor, ctx.isAdmin, visible);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.get("/api/cases/:caseId/software-impact", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    try {
      return await deps.softwareImpact.list(caseId, ctx.actor, ctx.isAdmin);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/software-impact", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "software_impact_record",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    const body = asRecord(request.body);
    const status = str(body.status);
    if (!status) {
      void reply.code(400);
      return { error: "invalid", detail: "$.status: missing required key" };
    }
    try {
      const created = await deps.softwareImpact.record(
        caseId,
        ctx.actor,
        ctx.isAdmin,
        {
          productName: str(body.productName) ?? "",
          version: str(body.version) ?? "",
          build: str(body.build) ?? "",
          component: str(body.component) ?? "",
          environment: str(body.environment) ?? "",
          status,
          note: body.note ?? "",
        },
        request.ip,
      );
      void reply.code(201);
      return created;
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/software-impact/:impactId/status", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId, impactId } = request.params as { caseId: string; impactId: string };
    const body = asRecord(request.body);
    const status = str(body.status);
    if (!status) {
      void reply.code(400);
      return { error: "invalid", detail: "$.status: missing required key" };
    }
    try {
      return await deps.softwareImpact.setStatus(
        caseId,
        impactId,
        ctx.actor,
        ctx.isAdmin,
        status,
        body.note,
        request.ip,
      );
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/software-impact/:impactId/release", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId, impactId } = request.params as { caseId: string; impactId: string };
    try {
      return await deps.softwareImpact.release(caseId, impactId, ctx.actor, ctx.isAdmin, request.ip);
    } catch (error) {
      return domainError(reply, error);
    }
  });
}
