import {
  buildEffectiveCapabilityRows,
  canUse as canUseFromRolesAndGrants,
  usableCapabilities as usableFromRolesAndGrants,
  type AppRole,
  type Capability,
  type EffectiveCapabilityV1,
  type LocalCapabilityGrantV1,
  type UserProfileV1,
} from "@cd-collab/contracts";

/**
 * What roles/grants confer, regardless of current account status - for
 * admin inspection and audit ("this grant exists" stays visible even while
 * the account is suspended, so an admin can see why reactivating it would
 * restore exactly these capabilities).
 */
export function effectiveCapabilityRows(
  roles: readonly AppRole[],
  grants: readonly LocalCapabilityGrantV1[],
): EffectiveCapabilityV1[] {
  return buildEffectiveCapabilityRows(roles, grants);
}

/**
 * What the account can actually use right now. This is the single
 * enforcement point every capability-gated route must call: a suspended or
 * disabled profile, and an imported_historical attribution-only stub,
 * always resolve to zero capabilities here regardless of role or local
 * grant. Never duplicate this rule inline in a route handler.
 */
export function usableCapabilities(
  profile: Pick<UserProfileV1, "status" | "provenance">,
  roles: readonly AppRole[],
  grants: readonly LocalCapabilityGrantV1[],
): Capability[] {
  return usableFromRolesAndGrants(
    profile,
    roles,
    grants.map((grant) => grant.capability),
  );
}

export function canUse(
  profile: Pick<UserProfileV1, "status" | "provenance">,
  roles: readonly AppRole[],
  grants: readonly LocalCapabilityGrantV1[],
  capability: Capability,
): boolean {
  return canUseFromRolesAndGrants(
    profile,
    roles,
    grants.map((grant) => grant.capability),
    capability,
  );
}
