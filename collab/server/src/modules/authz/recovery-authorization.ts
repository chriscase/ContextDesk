import {
  hasCapability,
  profileCanUseCapabilities,
  usableCapabilities,
  type AppRole,
  type Capability,
} from "@cd-collab/contracts";
import type { AuthIdentity } from "../auth/index.js";
import type { SessionGrantLookup, SessionProfileLookup } from "./session-authorization.js";

/**
 * Restart recovery has no cookie session. Re-resolve the recorded requester
 * from live profile status/provenance, live groups→roles, and live local
 * grants. Never reuse login-time or job-time roles.
 */
export interface RecoveryRequester {
  id: string;
  username: string;
}

export interface RecoveryAuthorizationDeps {
  lookupGroups(identity: AuthIdentity): Promise<string[]>;
  roles: { resolve(groups: readonly string[]): AppRole[] };
  profiles: SessionProfileLookup;
  grants: SessionGrantLookup;
}

export type RecoveryInactiveReason =
  | "missing_profile"
  | "suspended"
  | "disabled"
  | "imported_historical";

export type RecoveryAuthResult =
  | {
      kind: "authorized";
      actor: { id: string; username: string };
      roles: AppRole[];
      capabilities: Capability[];
      isAdmin: boolean;
      has: (capability: Capability) => boolean;
    }
  | { kind: "inactive"; reason: RecoveryInactiveReason }
  | { kind: "unavailable" };

function inactiveReason(profile: {
  status: string;
  provenance: string;
}): RecoveryInactiveReason | null {
  if (profile.provenance === "imported_historical") return "imported_historical";
  if (profile.status === "suspended") return "suspended";
  if (profile.status === "disabled") return "disabled";
  if (!profileCanUseCapabilities(profile)) return "missing_profile";
  return null;
}

/**
 * Current-authority seam for recovered queued work. Fail closed when the
 * profile or grant store cannot be read. Do not consult a session record.
 */
export async function authorizeRecoveryRequester(
  requester: RecoveryRequester,
  deps: RecoveryAuthorizationDeps,
): Promise<RecoveryAuthResult> {
  let profile: { status: string; provenance: string } | null;
  try {
    profile = await deps.profiles.getById(requester.id);
  } catch {
    return { kind: "unavailable" };
  }
  if (!profile) return { kind: "inactive", reason: "missing_profile" };
  const blocked = inactiveReason(profile);
  if (blocked) return { kind: "inactive", reason: blocked };

  let grants: readonly { capability: Capability }[];
  let groups: string[];
  try {
    grants = await deps.grants.list(requester.id);
    groups = await deps.lookupGroups({
      id: requester.id,
      username: requester.username,
      displayName: requester.username,
    });
  } catch {
    return { kind: "unavailable" };
  }

  const roles = deps.roles.resolve(groups);
  const capabilities = usableCapabilities(
    profile,
    roles,
    grants.map((grant) => grant.capability),
  );
  return {
    kind: "authorized",
    actor: { id: requester.id, username: requester.username },
    roles,
    capabilities,
    isAdmin: roles.includes("admin"),
    has: (capability) => hasCapability(capabilities, capability),
  };
}

export function bindRecoveryAuthorization(
  deps: RecoveryAuthorizationDeps,
): (requester: RecoveryRequester) => Promise<RecoveryAuthResult> {
  return (requester) => authorizeRecoveryRequester(requester, deps);
}
