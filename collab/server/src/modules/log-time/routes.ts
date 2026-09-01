import {
  ContractViolation,
  LOG_CHRONOLOGY_QUERY_SCHEMA_ID,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  capabilityForbidden,
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { AuditStore } from "../audit/index.js";
import type { CaseService } from "../cases/index.js";
import {
  LogTimeConflictError,
  LogTimeNotFoundError,
  LogTimeRequestError,
} from "./bridge.js";
import type { LogTimeService } from "./service.js";

type DeniedAction =
  | "log_corpus_build"
  | "log_chronology"
  | "log_time_preview"
  | "log_time_apply"
  | "log_time_clear"
  | "log_time_undo";

/**
 * Public error text. Contract and host messages are already free of paths and
 * credentials; anything else collapses to a generic string so an internal
 * failure never becomes a disclosure channel.
 */
function publicError(err: unknown): string {
  if (
    err instanceof ContractViolation ||
    err instanceof LogTimeConflictError ||
    err instanceof LogTimeNotFoundError ||
    err instanceof LogTimeRequestError
  ) {
    return err.message.length > 240 ? "invalid" : err.message;
  }
  return "invalid";
}

function statusFor(err: unknown): number {
  if (err instanceof LogTimeConflictError) return 409;
  if (err instanceof LogTimeNotFoundError) return 404;
  return 400;
}

export interface LogTimeRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  logTime: LogTimeService;
  cases: Pick<CaseService, "getCase">;
}

export async function registerLogTimeRoutes(
  app: FastifyInstance,
  deps: LogTimeRouteDeps,
): Promise<void> {
  const sessionOf = async (
    request: FastifyRequest,
    reply: { code: (status: number) => unknown },
  ) => requireSessionCapability(request, reply, deps.sessionAuth);

  const requireAccess = async (
    ctx: AuthorizedSession,
    caseId: string,
    reply: { code: (status: number) => unknown },
    deniedAction: DeniedAction,
    origin: string,
  ): Promise<boolean> => {
    const deny = async (status: number) => {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: deniedAction,
        target: caseId,
        origin,
        outcome: "denied",
      });
      void reply.code(status);
      return false;
    };
    if (!ctx.has("investigation:read")) return deny(403);
    if (!(await deps.cases.getCase(caseId, ctx.actor, ctx.isAdmin))) {
      return deny(404);
    }
    return true;
  };

  /** Read state. Requires read; never mutates. */
  app.get("/api/cases/:id/log-time", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!(await requireAccess(ctx, id, reply, "log_time_preview", request.ip))) {
      return { error: "not_found" };
    }
    try {
      const state = await deps.logTime.getState(
        id,
        ctx.has("evidence:private:read"),
      );
      const dependents = await deps.logTime.listDependents(
        id,
        ctx.has("evidence:private:read"),
      );
      return { state, dependents };
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  /** Read-only normalized chronology. Cursor changes never mutate the corpus. */
  app.get("/api/cases/:id/log-time/chronology", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!(await requireAccess(ctx, id, reply, "log_chronology", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.logTime.chronology(
        id,
        ctx.has("evidence:private:read"),
        chronologyQuery(request),
      );
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  /**
   * Mutating review routes. Each requires write capability, is audited on
   * denial, and surfaces a host conflict as 409 so a stale client re-reads
   * rather than retrying blind.
   */
  const mutation = (
    path: string,
    action: DeniedAction,
    run: (ctx: AuthorizedSession, id: string, body: unknown) => Promise<unknown>,
  ) => {
    app.post(path, { bodyLimit: 256 * 1024 }, async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return loaded.denied;
      const ctx = loaded.ctx;
      if (!ctx.has("investigation:write")) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action,
          target: id,
          origin: request.ip,
          outcome: "denied",
        });
        return capabilityForbidden(reply);
      }
      if (!(await requireAccess(ctx, id, reply, action, request.ip))) {
        return { error: "not_found" };
      }
      try {
        return await run(ctx, id, request.body);
      } catch (err) {
        void reply.code(statusFor(err));
        return { error: publicError(err) };
      }
    });
  };

  mutation("/api/cases/:id/log-time/build", "log_corpus_build", (ctx, id) =>
    deps.logTime.buildCorpus(
      id,
      ctx.actor,
      ctx.isAdmin,
      ctx.has("evidence:private:read"),
    ),
  );

  // Preview is a POST because it carries a body, but it publishes no revision.
  // It still requires write capability: it is the step before a durable change,
  // and it is the only place a proposed zone is named.
  mutation("/api/cases/:id/log-time/preview", "log_time_preview", (ctx, id, body) =>
    deps.logTime.preview(id, ctx.has("evidence:private:read"), body),
  );

  mutation("/api/cases/:id/log-time/apply", "log_time_apply", (ctx, id, body) =>
    deps.logTime.apply(id, ctx.actor, ctx.has("evidence:private:read"), body),
  );

  mutation("/api/cases/:id/log-time/clear", "log_time_clear", (ctx, id, body) =>
    deps.logTime.clear(id, ctx.actor, ctx.has("evidence:private:read"), body),
  );

  mutation("/api/cases/:id/log-time/undo", "log_time_undo", (ctx, id, body) =>
    deps.logTime.undo(id, ctx.actor, ctx.has("evidence:private:read"), body),
  );
}

function chronologyQuery(request: FastifyRequest): unknown {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const rawSources = query.sources;
  const sources = Array.isArray(rawSources)
    ? rawSources
    : rawSources === undefined
      ? []
      : [rawSources];
  const rawLimit = query.limit;
  const limit =
    typeof rawLimit === "number"
      ? rawLimit
      : typeof rawLimit === "string" && rawLimit.length > 0
        ? Number(rawLimit)
        : 0;
  return {
    schemaId: LOG_CHRONOLOGY_QUERY_SCHEMA_ID,
    search: typeof query.search === "string" ? query.search : null,
    sources,
    limit,
    cursor: typeof query.cursor === "string" ? query.cursor : null,
  };
}
