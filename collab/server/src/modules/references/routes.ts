import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import {
  CitedInvestigationNotAuthorizedError,
  CitingInvestigationNotVisibleError,
  DuplicateReferenceError,
  ReferenceNotFoundError,
  SelfReferenceError,
  type ReferenceService,
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
  if (error instanceof CitingInvestigationNotVisibleError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof ReferenceNotFoundError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof CitedInvestigationNotAuthorizedError) {
    void reply.code(403);
    return { error: "cited_investigation_forbidden" };
  }
  if (error instanceof SelfReferenceError) {
    void reply.code(400);
    return { error: "self_reference" };
  }
  if (error instanceof DuplicateReferenceError) {
    void reply.code(409);
    return { error: "already_referenced", existingId: error.existingId };
  }
  if (error instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${error.path}: ${error.detail}` };
  }
  void reply.code(400);
  return { error: "invalid", detail: error instanceof Error ? error.message : "invalid" };
}

export interface ReferenceRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  references: ReferenceService;
}

export async function registerReferenceRoutes(
  app: FastifyInstance,
  deps: ReferenceRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/cases/:caseId/references", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    try {
      return await deps.references.list(caseId, ctx.actor, ctx.isAdmin);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/references", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "investigation_reference_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    const body = asRecord(request.body);
    const toInvestigationId = str(body.toInvestigationId);
    if (!toInvestigationId) {
      void reply.code(400);
      return { error: "invalid", detail: "toInvestigationId is required" };
    }
    const input: {
      toInvestigationId: string;
      resourceKind?: string;
      resourceId?: string;
      note?: unknown;
      occurredAt?: unknown;
      occurredAtPrecision?: unknown;
      occurredAtZone?: unknown;
    } = { toInvestigationId };
    const resourceKind = str(body.resourceKind);
    if (resourceKind !== undefined) input.resourceKind = resourceKind;
    const resourceId = str(body.resourceId);
    if (resourceId !== undefined) input.resourceId = resourceId;
    if (body.note !== undefined) input.note = body.note;
    if (body.occurredAt !== undefined) input.occurredAt = body.occurredAt;
    if (body.occurredAtPrecision !== undefined) {
      input.occurredAtPrecision = body.occurredAtPrecision;
    }
    if (body.occurredAtZone !== undefined) input.occurredAtZone = body.occurredAtZone;
    try {
      const created = await deps.references.create(
        caseId,
        ctx.actor,
        ctx.isAdmin,
        input,
        request.ip,
      );
      void reply.code(201);
      return created;
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/references/:referenceId/withdraw", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId, referenceId } = request.params as { caseId: string; referenceId: string };
    try {
      return await deps.references.withdraw(
        caseId,
        referenceId,
        ctx.actor,
        ctx.isAdmin,
        request.ip,
      );
    } catch (error) {
      return domainError(reply, error);
    }
  });
}
