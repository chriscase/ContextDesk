import {
  ContractViolation,
  corpusIntakeError,
  corpusIntakeJsonBodyLimitBytes,
  type CorpusIntakeErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  capabilityForbidden,
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { CorpusIntakeConflictError, type CaseService } from "../cases/index.js";
import type { AuditStore } from "../audit/index.js";
import { CorpusIntakeRequestError, intakeError } from "./errors.js";
import type { CorpusIntakeSessionService } from "./session.js";

export interface CorpusIntakeSessionRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  sessions: CorpusIntakeSessionService;
  domain: Pick<CaseService, "getCase">;
}

/** Response body for a refused intake: the code is the contract, `error` keeps
 * the legacy string shape every existing client already reads. */
function errorBody(payload: CorpusIntakeErrorV1): CorpusIntakeErrorV1 & { error: string } {
  return { ...payload, error: payload.code };
}

function toIntakeError(err: unknown): CorpusIntakeRequestError {
  if (err instanceof CorpusIntakeRequestError) return err;
  if (err instanceof CorpusIntakeConflictError) {
    return intakeError("idempotency_conflict", "This intake conflicts with one already recorded.", {
      detail: err.message,
      status: 409,
    });
  }
  if (err instanceof ContractViolation) {
    // Contract detail carries the code as a `code: message` prefix where the
    // shape check can name one; keep the whole sentence for the operator.
    const [head] = err.detail.split(":");
    const code = (head ?? "").trim();
    const known = [
      "request_too_large",
      "expanded_budget_exceeded",
      "file_count_exceeded",
      "per_file_bytes_exceeded",
      "compressed_budget_exceeded",
      "path_too_long",
      "duplicate_path",
    ] as const;
    const matched = known.find((candidate) => candidate === code);
    return new CorpusIntakeRequestError(
      corpusIntakeError(matched ?? "session_state_invalid", err.message, { detail: err.message }),
      400,
    );
  }
  return intakeError("storage_unavailable", "The intake could not be completed.", {
    detail: err instanceof Error ? err.name : "unknown intake failure",
    retryable: true,
    status: 500,
  });
}

/**
 * Streamed corpus-intake session routes.
 *
 * Registered inside their own encapsulated scope so the raw `octet-stream`
 * parser these routes need cannot change how any other route reads a body.
 */
export async function registerCorpusIntakeSessionRoutes(
  app: FastifyInstance,
  deps: CorpusIntakeSessionRouteDeps,
): Promise<void> {
  const limits = deps.sessions.configuredLimits;
  await app.register(async (scope) => {
    // Binary parts are written straight to the intake spool. Handing Fastify the
    // untouched stream is what keeps a large upload from ever becoming a Buffer
    // or a string in this process.
    scope.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, done) => done(null, payload),
    );

    const sessionOf = async (request: FastifyRequest, reply: FastifyReply) =>
      requireSessionCapability(request, reply, deps.sessionAuth);

    /**
     * Resolve the session and the investigation, or the body to return instead.
     *
     * A denial is returned rather than sent so every route keeps the house
     * pattern of `return` deciding the response, and so an unauthorized reader
     * cannot tell a missing investigation from one they may not see.
     */
    type Authorized = { ctx: AuthorizedSession } | { denied: unknown };
    const authorize = async (
      request: FastifyRequest,
      reply: FastifyReply,
      caseId: string,
      action: string,
      write: boolean,
    ): Promise<Authorized> => {
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return { denied: loaded.denied };
      const ctx = loaded.ctx;
      const deny = async (status: number): Promise<Authorized> => {
        await deps.audit.append({
          identity: ctx.actor.id,
          action,
          target: caseId,
          origin: request.ip,
          outcome: "denied",
        });
        if (status === 403) return { denied: capabilityForbidden(reply) };
        void reply.code(status);
        return { denied: { error: "not_found" } };
      };
      if (write && !ctx.has("investigation:write")) return deny(403);
      if (!ctx.has("investigation:read")) return deny(403);
      if (!(await deps.domain.getCase(caseId, ctx.actor, ctx.isAdmin))) return deny(404);
      return { ctx };
    };

    const fail = (reply: FastifyReply, err: unknown) => {
      const error = toIntakeError(err);
      void reply.code(error.status);
      return errorBody(error.payload);
    };

    scope.post(
      "/api/cases/:id/corpus-intake/sessions",
      { bodyLimit: corpusIntakeJsonBodyLimitBytes(limits) },
      async (request, reply) => {
        const caseId = (request.params as { id: string }).id;
        const gate = await authorize(request, reply, caseId, "corpus_intake_preflight", true);
        if ("denied" in gate) return gate.denied;
        const ctx = gate.ctx;
        try {
          const session = await deps.sessions.preflight(caseId, ctx.actor, request.body);
          await deps.audit.append({
            identity: ctx.actor.id,
            action: "corpus_intake_preflight",
            target: session.sessionId,
            origin: request.ip,
            outcome: "success",
          });
          void reply.code(201);
          return session;
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    scope.get("/api/cases/:id/corpus-intake/sessions/:sessionId", async (request, reply) => {
      const params = request.params as { id: string; sessionId: string };
      const gate = await authorize(request, reply, params.id, "corpus_intake_session_read", false);
      if ("denied" in gate) return gate.denied;
      try {
        return await deps.sessions.status(params.id, params.sessionId);
      } catch (err) {
        return fail(reply, err);
      }
    });

    scope.put(
      "/api/cases/:id/corpus-intake/sessions/:sessionId/parts/:index",
      { bodyLimit: limits.maxRequestBytes },
      async (request, reply) => {
        const params = request.params as { id: string; sessionId: string; index: string };
        const gate = await authorize(request, reply, params.id, "corpus_intake_part", true);
        if ("denied" in gate) return gate.denied;
        const index = Number.parseInt(params.index, 10);
        const offsetRaw = (request.query as { offset?: string }).offset ?? "0";
        const offset = Number.parseInt(offsetRaw, 10);
        if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0) {
          return fail(reply, intakeError(
            "session_state_invalid",
            "This upload named a part or offset the server cannot use.",
            { detail: "part index and offset must be non-negative integers" },
          ));
        }
        const body = request.body as AsyncIterable<Uint8Array> | undefined;
        if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
          return fail(reply, intakeError(
            "session_state_invalid",
            "Upload parts must be sent as application/octet-stream.",
            { detail: "request body was not a binary stream" },
          ));
        }
        try {
          return await deps.sessions.receivePart(params.id, params.sessionId, index, offset, body);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    scope.post(
      "/api/cases/:id/corpus-intake/sessions/:sessionId/preview",
      { bodyLimit: corpusIntakeJsonBodyLimitBytes(limits) },
      async (request, reply) => {
        const params = request.params as { id: string; sessionId: string };
        const gate = await authorize(request, reply, params.id, "corpus_intake_preview", true);
        if ("denied" in gate) return gate.denied;
        try {
          return await deps.sessions.expand(params.id, gate.ctx.actor, params.sessionId);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    scope.post(
      "/api/cases/:id/corpus-intake/sessions/:sessionId/commit",
      { bodyLimit: corpusIntakeJsonBodyLimitBytes(limits) },
      async (request, reply) => {
        const params = request.params as { id: string; sessionId: string };
        const gate = await authorize(request, reply, params.id, "corpus_intake_commit", true);
        if ("denied" in gate) return gate.denied;
        try {
          return await deps.sessions.commit(
            params.id,
            gate.ctx.actor,
            params.sessionId,
            request.body,
            request.ip,
          );
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    scope.delete("/api/cases/:id/corpus-intake/sessions/:sessionId", async (request, reply) => {
      const params = request.params as { id: string; sessionId: string };
      const gate = await authorize(request, reply, params.id, "corpus_intake_cancel", true);
      if ("denied" in gate) return gate.denied;
      try {
        const cancelled = await deps.sessions.cancel(params.id, params.sessionId);
        await deps.audit.append({
          identity: gate.ctx.actor.id,
          action: "corpus_intake_cancel",
          target: params.sessionId,
          origin: request.ip,
          outcome: "success",
        });
        return cancelled;
      } catch (err) {
        return fail(reply, err);
      }
    });
  });
}
