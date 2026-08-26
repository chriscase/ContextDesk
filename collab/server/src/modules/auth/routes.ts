import {
  AUTH_ERROR_SCHEMA_ID,
  SESSION_SCHEMA_ID,
  profileCanUseCapabilities,
  usableCapabilities,
  type AppRole,
  type AuthErrorV1,
  type Capability,
  type DirectoryMappedField,
  type SessionResponseV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import type { AuthAdapter } from "./adapter.js";
import { DirectoryClaimsUnsafeError } from "./ldap-session.js";
import type { AuthLog } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  isSessionActive,
  type SessionPolicy,
  type SessionRecord,
  type SessionStore,
} from "./sessions.js";

export const SESSION_COOKIE = "cd_collab_session";

/**
 * Narrow structural port onto people/store.js's UserProfileStore, so this
 * module never imports the people module directly. touchOnLogin is the
 * canonical profile store's only writer for identity/provenance/timestamp
 * fields - see people/store.ts for the create-vs-touch-vs-collision rules.
 */
export interface LoginProfileSync {
  touchOnLogin(input: {
    id: string;
    username: string;
    displayName: string;
    provenance: "local" | "ldap";
    directorySubject: string | null;
    directoryFields?: Partial<Record<DirectoryMappedField, string>>;
  }): Promise<{ outcome: "ok" | "collision" }>;
  getById(id: string): Promise<{ status: string; provenance: string } | null>;
}

export interface LoginGrantLookup {
  list(userId: string): Promise<readonly { capability: Capability }[]>;
}

export interface AuthRouteDeps {
  adapter: AuthAdapter;
  sessions: SessionStore;
  policy: SessionPolicy;
  roles: { resolve(groups: readonly string[]): AppRole[] };
  audit: AuditStore;
  log: AuthLog;
  limiter: RateLimiter;
  cookieSecure: boolean;
  /** Optional: keeps the canonical profile store in sync on every successful login. */
  profiles?: LoginProfileSync;
  /** Optional: additive local grants used to populate the session capability list. */
  grants?: LoginGrantLookup;
}

export type ActiveSessionDeps = Pick<AuthRouteDeps, "sessions" | "policy" | "adapter">;

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
  deps: ActiveSessionDeps,
): Promise<SessionRecord | null> {
  const token = readCookie(request);
  if (!token) return null;
  const record = await deps.sessions.getByToken(token);
  if (!record || !isSessionActive(record, deps.policy)) return null;
  await deps.sessions.touch(record.id);
  let groups = record.groups;
  if (deps.adapter.groupRefreshMode !== "login_snapshot") {
    try {
      groups = await deps.adapter.lookupGroups(record.identity);
    } catch {
      // Live directory refresh is fail-closed. Snapshot adapters never enter
      // this branch because they have no independent service identity.
      groups = [];
    }
  }
  return { ...record, groups };
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

    let result;
    try {
      result = await deps.adapter.authenticate(username, password);
    } catch (err) {
      if (err instanceof DirectoryClaimsUnsafeError) {
        await deps.audit.append({
          identity: null,
          action: "login",
          target: "unsafe_directory_claims",
          origin: originOf(request),
          outcome: "denied",
        });
        deps.log.event({ event: "login_denied_unmapped", username: username.slice(0, 128) });
        void reply.code(403);
        return authError("access_denied");
      }
      throw err;
    }
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

    if (deps.profiles) {
      let existing: { status: string; provenance: string } | null;
      try {
        existing = await deps.profiles.getById(result.identity.id);
      } catch {
        void reply.code(403);
        return authError("access_denied");
      }
      if (existing && !profileCanUseCapabilities(existing)) {
        await deps.audit.append({
          identity: result.identity.id,
          action: "login",
          target: existing.provenance === "imported_historical" ? "historical" : existing.status,
          origin: originOf(request),
          outcome: "denied",
        });
        deps.log.event({
          event: "login_denied_inactive",
          username: result.identity.username,
        });
        void reply.code(403);
        return authError("access_denied");
      }
    }

    deps.limiter.reset(key);
    const { token, record } = await deps.sessions.create({
      identity: result.identity,
      groups: result.groups,
      ttlMs: deps.policy.ttlMs,
    });
    setSessionCookie(reply, token, deps);
    if (deps.profiles) {
      try {
        const sync = await deps.profiles.touchOnLogin({
          id: result.identity.id,
          username: result.identity.username,
          displayName: result.identity.displayName,
          provenance: deps.adapter.provenance,
          directorySubject: deps.adapter.provenance === "local" ? null : result.identity.id,
          ...(deps.adapter.provenance === "local" || result.directoryFields === undefined
            ? {}
            : { directoryFields: result.directoryFields }),
        });
        if (sync.outcome === "collision") {
          await deps.sessions.revoke(record.id);
          clearSessionCookie(reply, deps);
          await deps.audit.append({
            identity: result.identity.id,
            action: "profile_sync",
            target: "collision",
            origin: originOf(request),
            outcome: "failure",
          });
          void reply.code(403);
          return authError("access_denied");
        }
      } catch {
        await deps.sessions.revoke(record.id);
        clearSessionCookie(reply, deps);
        void reply.code(403);
        return authError("access_denied");
      }
      let after: { status: string; provenance: string } | null;
      try {
        after = await deps.profiles.getById(result.identity.id);
      } catch {
        after = null;
      }
      if (!after || !profileCanUseCapabilities(after)) {
        await deps.sessions.revoke(record.id);
        clearSessionCookie(reply, deps);
        await deps.audit.append({
          identity: result.identity.id,
          action: "login",
          target: "inactive",
          origin: originOf(request),
          outcome: "denied",
        });
        void reply.code(403);
        return authError("access_denied");
      }
    }
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
      capabilities: await sessionCapabilities(deps, record.identity.id, roles),
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
    if (deps.profiles) {
      let profile: { status: string; provenance: string } | null;
      try {
        profile = await deps.profiles.getById(session.identity.id);
      } catch {
        void reply.code(401);
        return authError("unauthenticated");
      }
      if (!profile || !profileCanUseCapabilities(profile)) {
        void reply.code(401);
        return authError("unauthenticated");
      }
    }
    const bodyOut: SessionResponseV1 = {
      schemaId: SESSION_SCHEMA_ID,
      identity: session.identity,
      roles,
      capabilities: await sessionCapabilities(deps, session.identity.id, roles),
    };
    return bodyOut;
  });
}

async function sessionCapabilities(
  deps: AuthRouteDeps,
  identityId: string,
  roles: readonly AppRole[],
): Promise<Capability[]> {
  if (!deps.profiles) return usableCapabilities({ status: "active", provenance: "local" }, roles, []);
  let profile: { status: string; provenance: string } | null;
  try {
    profile = await deps.profiles.getById(identityId);
  } catch {
    return [];
  }
  if (!profile) return [];
  let grants: Capability[] = [];
  if (deps.grants) {
    try {
      grants = (await deps.grants.list(identityId)).map((row) => row.capability);
    } catch {
      return [];
    }
  }
  return usableCapabilities(profile, roles, grants);
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
