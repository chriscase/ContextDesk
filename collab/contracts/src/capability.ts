/**
 * Fine-grained capability model, versioned independently of the coarse role
 * list in auth.ts. Roles remain the group-mapping and UI-facing concept;
 * capabilities are the unit servers actually enforce on mutating routes.
 * UI visibility is never authorization — every route that reads or writes
 * something capability-gated must call hasCapability itself.
 */
import { APP_ROLES, type AppRole } from "./auth.js";

export const CAPABILITY_MODEL_VERSION = 1 as const;

export const CAPABILITIES = [
  "investigation:read",
  "investigation:write",
  "evidence:private:read",
  "run:strategies",
  "decision:accept",
  "export:create",
  "portable:restore",
  "admin:users",
  "admin:system_config",
  "audit:view",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Default role -> capability matrix (accepted design, documented in the
 * identity/administration handbook chapter). Local grants in admin-people.ts
 * can add capabilities on top of a role; nothing here ever subtracts from a
 * role's default set on a per-user basis.
 */
export const ROLE_CAPABILITIES: Readonly<Record<AppRole, readonly Capability[]>> = {
  viewer: ["investigation:read"],
  contributor: ["investigation:read", "investigation:write"],
  "case-lead": [
    "investigation:read",
    "investigation:write",
    "evidence:private:read",
    "run:strategies",
    "decision:accept",
    "export:create",
    "portable:restore",
  ],
  admin: [...CAPABILITIES],
};

for (const role of APP_ROLES) {
  if (!(role in ROLE_CAPABILITIES)) {
    throw new Error(`ROLE_CAPABILITIES is missing an entry for role ${role}`);
  }
}

/** Capabilities granted by roles alone, in stable declaration order. */
export function roleCapabilities(roles: readonly AppRole[]): Capability[] {
  const set = new Set<Capability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) set.add(capability);
  }
  return CAPABILITIES.filter((capability) => set.has(capability));
}

/**
 * Effective capabilities from roles plus local grants. Local grants are
 * additive only: there is no way to grant a role, only individual
 * capabilities, which keeps the blast radius of a mistaken grant bounded
 * and auditable one capability at a time.
 */
export function resolveCapabilities(
  roles: readonly AppRole[],
  localGrants: readonly Capability[] = [],
): Capability[] {
  const set = new Set<Capability>(roleCapabilities(roles));
  for (const capability of localGrants) {
    if (isCapability(capability)) set.add(capability);
  }
  return CAPABILITIES.filter((capability) => set.has(capability));
}

export function hasCapability(
  effective: readonly Capability[],
  capability: Capability,
): boolean {
  return effective.includes(capability);
}
