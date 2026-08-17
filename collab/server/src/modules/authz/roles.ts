import { APP_ROLES, type AppRole } from "@cd-collab/contracts";

export { APP_ROLES, type AppRole };

export type AuthzAction = "read" | "mutate" | "lead" | "admin";

const RANK: Record<AppRole, number> = {
  viewer: 1,
  contributor: 2,
  "case-lead": 3,
  admin: 4,
};

export function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

export function canPerform(roles: readonly AppRole[], action: AuthzAction): boolean {
  const max = roles.reduce((acc, role) => Math.max(acc, RANK[role] ?? 0), 0);
  switch (action) {
    case "read":
      return max >= RANK.viewer;
    case "mutate":
      return max >= RANK.contributor;
    case "lead":
      return max >= RANK["case-lead"];
    case "admin":
      return max >= RANK.admin;
  }
}

export interface GroupRoleMapping {
  /** Lowercased group DN/name → role */
  entries: Map<string, AppRole>;
}

export function emptyMapping(): GroupRoleMapping {
  return { entries: new Map() };
}

export function parseGroupRoleMap(raw: string | undefined): GroupRoleMapping {
  const mapping = emptyMapping();
  if (!raw?.trim()) return mapping;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.lastIndexOf("=");
    if (eq <= 0) {
      throw new Error(`invalid COLLAB_GROUP_ROLE_MAP entry: ${trimmed}`);
    }
    const group = trimmed.slice(0, eq).trim().toLowerCase();
    const role = trimmed.slice(eq + 1).trim();
    if (!isAppRole(role)) {
      throw new Error(`invalid role in COLLAB_GROUP_ROLE_MAP: ${role}`);
    }
    mapping.entries.set(group, role);
  }
  return mapping;
}

export function resolveRoles(
  groups: readonly string[],
  mapping: GroupRoleMapping,
): AppRole[] {
  const roles = new Set<AppRole>();
  for (const group of groups) {
    const role = mapping.entries.get(group.toLowerCase());
    if (role) roles.add(role);
  }
  return APP_ROLES.filter((r) => roles.has(r));
}

export class MutableGroupRoleMap {
  private mapping: GroupRoleMapping;

  constructor(initial: GroupRoleMapping = emptyMapping()) {
    this.mapping = { entries: new Map(initial.entries) };
  }

  snapshot(): GroupRoleMapping {
    return { entries: new Map(this.mapping.entries) };
  }

  resolve(groups: readonly string[]): AppRole[] {
    return resolveRoles(groups, this.mapping);
  }

  set(groupDn: string, role: AppRole): void {
    this.mapping.entries.set(groupDn.toLowerCase(), role);
  }

  delete(groupDn: string): void {
    this.mapping.entries.delete(groupDn.toLowerCase());
  }

  replace(next: GroupRoleMapping): void {
    this.mapping = { entries: new Map(next.entries) };
  }
}
