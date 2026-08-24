import { AUTH_ERROR_SCHEMA_ID, ContractViolation, type AuthErrorV1 } from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ActiveSessionDeps } from "../auth/index.js";
import { resolveActiveSession } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import { CorpusIntakeConflictError, type Actor, type CaseService } from "../cases/index.js";
import type { AuditStore } from "../audit/index.js";
import { ZipError } from "./zip.js";

function publicIntakeError(err: unknown): string {
  if (err instanceof ContractViolation) return err.message;
  if (err instanceof ZipError) return err.message;
  if (err instanceof CorpusIntakeConflictError) return err.message;
  if (err instanceof Error) {
    const message = err.message.trim();
    if (
      message === "hash verification failed after storage" ||
      message === "case not found" ||
      message.endsWith("is not valid base64") ||
      message.endsWith("is not a bounded token")
    ) {
      return message.length > 240 ? "invalid" : message;
    }
  }
  return "invalid";
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

export interface CorpusIntakeRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  domain: Pick<
    CaseService,
    | "previewCorpusIntake"
    | "commitCorpusIntake"
    | "getCorpusIntakeBatch"
    | "getCase"
    | "isMemberOf"
  >;
}

export async function registerCorpusIntakeRoutes(
  app: FastifyInstance,
  deps: CorpusIntakeRouteDeps,
): Promise<void> {
  const sessionOf = async (request: FastifyRequest) => {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: {
        id: session.identity.id,
        username: session.identity.username,
      } satisfies Actor,
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
      canWrite: canPerform(roles, "mutate"),
    };
  };

  const requireAccess = async (
    ctx: { actor: Actor; isAdmin: boolean; canRead: boolean },
    caseId: string,
    reply: { code: (status: number) => unknown },
    deniedAction?: "corpus_intake_preview" | "corpus_intake_commit",
    deniedOrigin?: string,
  ): Promise<boolean> => {
    if (!ctx.canRead) {
      if (deniedAction) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: deniedAction,
          target: caseId,
          origin: deniedOrigin ?? null,
          outcome: "denied",
        });
      }
      void reply.code(403);
      return false;
    }
    if (!(await deps.domain.getCase(caseId, ctx.actor, ctx.isAdmin))) {
      if (deniedAction) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: deniedAction,
          target: caseId,
          origin: deniedOrigin ?? null,
          outcome: "denied",
        });
      }
      void reply.code(404);
      return false;
    }
    return true;
  };

  app.post(
    "/api/cases/:id/corpus-intake/preview",
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const ctx = await sessionOf(request);
      if (!ctx) {
        void reply.code(401);
        return authError("unauthenticated");
      }
      if (!ctx.canWrite) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "corpus_intake_preview",
          target: id,
          origin: request.ip,
          outcome: "denied",
        });
        void reply.code(403);
        return authError("forbidden");
      }
      if (!(await requireAccess(ctx, id, reply, "corpus_intake_preview", request.ip))) {
        return { error: "not_found" };
      }
      try {
        return await deps.domain.previewCorpusIntake(id, ctx.actor, request.body);
      } catch (err) {
        void reply.code(err instanceof CorpusIntakeConflictError ? 409 : 400);
        return { error: publicIntakeError(err) };
      }
    },
  );

  app.post(
    "/api/cases/:id/corpus-intake",
    { bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const ctx = await sessionOf(request);
      if (!ctx) {
        void reply.code(401);
        return authError("unauthenticated");
      }
      if (!ctx.canWrite) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "corpus_intake_commit",
          target: id,
          origin: request.ip,
          outcome: "denied",
        });
        void reply.code(403);
        return authError("forbidden");
      }
      if (!(await requireAccess(ctx, id, reply, "corpus_intake_commit", request.ip))) {
        return { error: "not_found" };
      }
      try {
        return await deps.domain.commitCorpusIntake(id, ctx.actor, request.body, request.ip);
      } catch (err) {
        void reply.code(err instanceof CorpusIntakeConflictError ? 409 : 400);
        return { error: publicIntakeError(err) };
      }
    },
  );

  app.get("/api/cases/:id/corpus-intake/:batchId", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const params = request.params as { id: string; batchId: string };
    if (!(await requireAccess(ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    const batch = await deps.domain.getCorpusIntakeBatch(params.id, params.batchId);
    if (!batch) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return batch;
  });
}
