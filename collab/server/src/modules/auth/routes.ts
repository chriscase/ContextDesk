import {
  AUTH_ERROR_SCHEMA_ID,
  SESSION_SCHEMA_ID,
  type AppRole,
  type AuthErrorV1,
  type SessionResponseV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import type { AuthAdapter } from "./adapter.js";
import type { AuthLog } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  isSessionActive,
  type SessionPolicy,
  type SessionRecord,
  type SessionStore,
} from "./sessions.js";

export const SESSION_COOKIE = "cd_collab_session";

export interface AuthRouteDeps {
  adapter: AuthAdapter;
  sessions: SessionStore;
  policy: SessionPolicy;
  roles: { resolve(groups: readonly string[]): AppRole[] };
  audit: AuditStore;
  log: AuthLog;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function originOf(request: FastifyRequest): string {
  return request.ip;
}

function readCookie(request: FastifyRequest): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function resolveActiveSession(
  request: FastifyRequest,
  deps: Pick<AuthRouteDeps, "sessions" | "policy">,
): Promise<SessionRecord | null> {
  const token = readCookie(request);
  if (!token) return null;
  const record = await deps.sessions.getByToken(token);
  if (!record || !isSessionActive(record, deps.policy)) return null;
  await deps.sessions.touch(record.id);
  return record;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const key = request.ip;
    if (deps.limiter.tooMany(key)) {
      await deps.audit.append({
        identity: null,
        action: "login",
        target: "rate_limited",
        origin: originOf(request),
        outcome: "denied",
      });
      deps.log.event({ event: "login_rate_limited" });
      void reply.code(429);
      return authError("rate_limited");
    }

    const body = request.body;
    const username =
      typeof body === "object" &&
      body !== null &&
      "username" in body &&
      typeof (body as { username: unknown }).username === "string"
        ? (body as { username: string }).username
        : "";
    const password =
      typeof body === "object" &&
      body !== null &&
      "password" in body &&
      typeof (body as { password: unknown }).password === "string"
        ? (body as { password: string }).password
        : "";

    const result = await deps.adapter.authenticate(username, password);
    if (!result) {
      deps.limiter.fail(key);
      await deps.audit.append({
        identity: null,
        action: "login",
        target: "invalid_credentials",
        origin: originOf(request),
        outcome: "failure",
      });
      deps.log.event({ event: "login_failure" });
      void reply.code(401);
      return authError("invalid_credentials");
    }

    const roles = deps.roles.resolve(result.groups);
    if (roles.length === 0) {
      await deps.audit.append({
        identity: result.identity.id,
        action: "login",
        target: "unmapped",
        origin: originOf(request),
        outcome: "denied",
      });
      deps.log.event({
        event: "login_denied_unmapped",
        username: result.identity.username,
      });
      void reply.code(403);
      return authError("access_denied");
    }

    deps.limiter.reset(key);
    const { token, record } = await deps.sessions.create({
      identity: result.identity,
      groups: result.groups,
      ttlMs: deps.policy.ttlMs,
    });
    setSessionCookie(reply, token, deps);
    await deps.audit.append({
      identity: record.identity.id,
      action: "login",
      target: `roles=${roles.join(",")}`,
      origin: originOf(request),
      outcome: "success",
    });
    deps.log.event({
      event: "login_success",
      username: record.identity.username,
    });
    const bodyOut: SessionResponseV1 = {
      schemaId: SESSION_SCHEMA_ID,
      identity: record.identity,
      roles,
    };
    return bodyOut;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await resolveActiveSession(request, deps);
    if (session) {
      await deps.sessions.revoke(session.id);
      await deps.audit.append({
        identity: session.identity.id,
        action: "logout",
        target: session.id,
        origin: originOf(request),
        outcome: "success",
      });
      deps.log.event({ event: "logout", username: session.identity.username });
    }
    clearSessionCookie(reply, deps);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const session = await resolveActiveSession(request, deps);
    if (!session) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const roles = deps.roles.resolve(session.groups);
    const bodyOut: SessionResponseV1 = {
      schemaId: SESSION_SCHEMA_ID,
      identity: session.identity,
      roles,
    };
    return bodyOut;
  });
}

function setSessionCookie(
  reply: FastifyReply,
  token: string,
  deps: AuthRouteDeps,
): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(deps.policy.ttlMs / 1000)}`,
  ];
  if (deps.cookieSecure) parts.push("Secure");
  void reply.header("set-cookie", parts.join("; "));
}

function clearSessionCookie(reply: FastifyReply, deps: AuthRouteDeps): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (deps.cookieSecure) parts.push("Secure");
  void reply.header("set-cookie", parts.join("; "));
}
