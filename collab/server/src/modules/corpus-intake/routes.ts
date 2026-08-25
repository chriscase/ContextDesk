import { ContractViolation } from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  capabilityForbidden,
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { CorpusIntakeConflictError, type CaseService } from "../cases/index.js";
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

export interface CorpusIntakeRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
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
  const sessionOf = async (
    request: FastifyRequest,
    reply: { code: (status: number) => unknown },
  ) => requireSessionCapability(request, reply, deps.sessionAuth);

  const requireAccess = async (
    ctx: AuthorizedSession,
    caseId: string,
    reply: { code: (status: number) => unknown },
    deniedAction?: "corpus_intake_preview" | "corpus_intake_commit",
    deniedOrigin?: string,
  ): Promise<boolean> => {
    if (!ctx.has("investigation:read")) {
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
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return loaded.denied;
      const ctx = loaded.ctx;
      if (!ctx.has("investigation:write")) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "corpus_intake_preview",
          target: id,
          origin: request.ip,
          outcome: "denied",
        });
        return capabilityForbidden(reply);
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
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return loaded.denied;
      const ctx = loaded.ctx;
      if (!ctx.has("investigation:write")) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "corpus_intake_commit",
          target: id,
          origin: request.ip,
          outcome: "denied",
        });
        return capabilityForbidden(reply);
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
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
