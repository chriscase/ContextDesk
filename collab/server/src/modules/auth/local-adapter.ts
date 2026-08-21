import type { IdentityV1 } from "@cd-collab/contracts";
import { MapAuthAdapter, type AuthAdapter } from "./adapter.js";

interface LocalUserConfig {
  username: string;
  password: string;
  displayName?: string;
  groups: string[];
}

/**
 * Explicit local-auth adapter for private deployments and development. The
 * password is read once from configuration and held only by the auth module;
 * it never crosses the route or session boundary. LDAP remains the default
 * production mode.
 */
export function loadLocalAuthAdapter(
  env: NodeJS.ProcessEnv = process.env,
): AuthAdapter {
  const raw = env.COLLAB_LOCAL_USERS?.trim();
  if (!raw) {
    throw new Error("COLLAB_AUTH_MODE=local requires COLLAB_LOCAL_USERS");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("COLLAB_LOCAL_USERS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("COLLAB_LOCAL_USERS must be a non-empty JSON array");
  }
  const users = new Map<string, { password: string; identity: IdentityV1; groups: string[] }>();
  for (const value of parsed) {
    if (!isLocalUserConfig(value)) throw new Error("COLLAB_LOCAL_USERS contains an invalid user");
    if (users.has(value.username)) throw new Error("COLLAB_LOCAL_USERS contains duplicate usernames");
    users.set(value.username, {
      password: value.password,
      identity: {
        id: `local:${value.username}`,
        username: value.username,
        displayName: value.displayName ?? value.username,
      },
      groups: [...value.groups],
    });
  }
  return new MapAuthAdapter(users);
}

function isLocalUserConfig(value: unknown): value is LocalUserConfig {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<LocalUserConfig>;
  return typeof row.username === "string"
    && row.username.trim().length > 0
    && typeof row.password === "string"
    && row.password.length > 0
    && (row.displayName === undefined || typeof row.displayName === "string")
    && Array.isArray(row.groups)
    && row.groups.length > 0
    && row.groups.every((group) => typeof group === "string" && group.trim().length > 0);
}
