import {
  AUTH_ERROR_SCHEMA_ID,
  hasCapability,
  profileCanUseCapabilities,
  usableCapabilities,
  type AppRole,
  type AuthErrorV1,
  type Capability,
} from "@cd-collab/contracts";
import type { FastifyRequest } from "fastify";
import {
  resolveActiveSession,
  type ActiveSessionDeps,
  type AuthIdentity,
} from "../auth/index.js";
import type { MutableGroupRoleMap } from "./roles.js";

export interface SessionProfileLookup {
  getById(id: string): Promise<{ status: string; provenance: string } | null>;
}

export interface SessionGrantLookup {
  list(userId: string): Promise<readonly { capability: Capability }[]>;
}

export interface SessionAuthorizationDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  profiles: SessionProfileLookup;
  grants: SessionGrantLookup;
}

export interface AuthorizedSession {
  identity: AuthIdentity;
  actor: { id: string; username: string };
  roles: AppRole[];
  capabilities: Capability[];
  /**
   * Membership bypass for listing/reading every case. This stays the admin
   * *role*, not admin:users — a local people-admin grant must not become a
   * cross-investigation read.
   */
  isAdmin: boolean;
  has(capability: Capability): boolean;
}

export type SessionAuthResult =
  | { kind: "ok"; ctx: AuthorizedSession }
  | { kind: "unauthenticated" }
  | { kind: "inactive" }
  | { kind: "unavailable" };

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

/**
 * Single session authorization path for War Room routes: cookie session,
 * live group→role map, current profile status/provenance, and additive
 * local grants. Capabilities are never cached on the session record.
 * Restart recovery of queued triage jobs uses authorizeRecoveryRequester
 * in recovery-authorization.ts instead of this cookie path.
 */
export async function authorizeSession(
  request: FastifyRequest,
  deps: SessionAuthorizationDeps,
): Promise<SessionAuthResult> {
  const session = await resolveActiveSession(request, deps.auth);
  if (!session) return { kind: "unauthenticated" };
  let groups = session.groups;
  if (groups.length === 0) {
    try {
      groups = await deps.auth.adapter.lookupGroups(session.identity);
    } catch {
      return { kind: "unavailable" };
    }
  }
  const roles = deps.roles.resolve(groups);
  let profile: { status: string; provenance: string } | null;
  let grants: readonly { capability: Capability }[];
  try {
    profile = await deps.profiles.getById(session.identity.id);
    grants = profile ? await deps.grants.list(session.identity.id) : [];
  } catch {
    return { kind: "unavailable" };
  }
  if (!profile || !profileCanUseCapabilities(profile)) {
    return { kind: "inactive" };
  }
  const capabilities = usableCapabilities(
    profile,
    roles,
    grants.map((grant) => grant.capability),
  );
  const ctx: AuthorizedSession = {
    identity: session.identity,
    actor: { id: session.identity.id, username: session.identity.username },
    roles,
    capabilities,
    isAdmin: roles.includes("admin"),
    has: (capability) => hasCapability(capabilities, capability),
  };
  return { kind: "ok", ctx };
}

/**
 * Translate a failed authorizeSession result into an HTTP body. Inactive
 * profiles fail closed as unauthenticated so a revoked or suspended
 * session cannot keep using the cookie.
 */
export function sessionAuthFailure(
  reply: { code: (status: number) => unknown },
  result: Exclude<SessionAuthResult, { kind: "ok" }>,
): AuthErrorV1 | { error: "unavailable" } {
  if (result.kind === "unavailable") {
    void reply.code(503);
    return { error: "unavailable" };
  }
  void reply.code(401);
  return authError("unauthenticated");
}

export function capabilityForbidden(reply: { code: (status: number) => unknown }): AuthErrorV1 {
  void reply.code(403);
  return authError("forbidden");
}

export type SessionGate =
  | { ctx: AuthorizedSession }
  | { denied: AuthErrorV1 | { error: "unavailable" } };

export async function requireSessionCapability(
  request: FastifyRequest,
  reply: { code: (status: number) => unknown },
  deps: SessionAuthorizationDeps,
  capability?: Capability,
): Promise<SessionGate> {
  const resolved = await authorizeSession(request, deps);
  if (resolved.kind !== "ok") {
    return { denied: sessionAuthFailure(reply, resolved) };
  }
  if (capability && !resolved.ctx.has(capability)) {
    return { denied: capabilityForbidden(reply) };
  }
  return { ctx: resolved.ctx };
}

/** Membership-preserving flags derived from the live capability set. */
export function sessionCapabilityFlags(ctx: AuthorizedSession): {
  canRead: boolean;
  canWrite: boolean;
  canRunStrategies: boolean;
  canAccept: boolean;
  canExport: boolean;
  canRestore: boolean;
  canReadPrivate: boolean;
  canAdminUsers: boolean;
  canSystemConfig: boolean;
  canAuditView: boolean;
} {
  return {
    canRead: ctx.has("investigation:read"),
    canWrite: ctx.has("investigation:write"),
    canRunStrategies: ctx.has("run:strategies"),
    canAccept: ctx.has("decision:accept"),
    canExport: ctx.has("export:create"),
    canRestore: ctx.has("portable:restore"),
    canReadPrivate: ctx.has("evidence:private:read"),
    canAdminUsers: ctx.has("admin:users"),
    canSystemConfig: ctx.has("admin:system_config"),
    canAuditView: ctx.has("audit:view"),
  };
}
