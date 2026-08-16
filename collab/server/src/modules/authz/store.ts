import type { Pool } from "pg";
import {
  emptyMapping,
  isAppRole,
  MutableGroupRoleMap,
  type AppRole,
  type GroupRoleMapping,
} from "./roles.js";

export interface GroupRoleStore {
  load(): Promise<GroupRoleMapping>;
  set(groupDn: string, role: AppRole, updatedBy: string): Promise<void>;
  delete(groupDn: string): Promise<boolean>;
}

function normalizeGroup(groupDn: string): string {
  return groupDn.trim().toLowerCase();
}

function mappingFromRows(rows: readonly Record<string, unknown>[]): GroupRoleMapping {
  const mapping = emptyMapping();
  for (const row of rows) {
    const group = String(row.group_dn);
    const role = String(row.role);
    if (!isAppRole(role)) {
      throw new Error(`invalid persisted role for group ${group}`);
    }
    mapping.entries.set(normalizeGroup(group), role);
  }
  return mapping;
}

export class MemoryGroupRoleStore implements GroupRoleStore {
  private readonly live: MutableGroupRoleMap;

  constructor(initial: GroupRoleMapping | MutableGroupRoleMap = emptyMapping()) {
    this.live =
      initial instanceof MutableGroupRoleMap
        ? initial
        : new MutableGroupRoleMap(initial);
  }

  async load(): Promise<GroupRoleMapping> {
    return this.live.snapshot();
  }

  async set(groupDn: string, role: AppRole, _updatedBy: string): Promise<void> {
    this.live.set(groupDn, role);
  }

  async delete(groupDn: string): Promise<boolean> {
    const had = this.live.snapshot().entries.has(normalizeGroup(groupDn));
    this.live.delete(groupDn);
    return had;
  }
}

export class PgGroupRoleStore implements GroupRoleStore {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly bootstrap: GroupRoleMapping = emptyMapping(),
  ) {}

  async load(): Promise<GroupRoleMapping> {
    const state = await this.pool.query(
      `SELECT id FROM authz_group_role_map_state WHERE id = TRUE`,
    );
    let result = await this.pool.query(
      `SELECT group_dn, role FROM authz_group_role_map ORDER BY group_dn ASC`,
    );
    if (state.rows.length === 0) {
      if (result.rows.length === 0 && this.bootstrap.entries.size > 0) {
        for (const [groupDn, role] of this.bootstrap.entries) {
          await this.set(groupDn, role, "environment-bootstrap");
        }
        result = await this.pool.query(
          `SELECT group_dn, role FROM authz_group_role_map ORDER BY group_dn ASC`,
        );
      }
      await this.pool.query(
        `INSERT INTO authz_group_role_map_state (id, initialized_by)
         VALUES (TRUE, $1)
         ON CONFLICT (id) DO NOTHING`,
        ["environment-bootstrap"],
      );
    }
    return mappingFromRows(result.rows as Record<string, unknown>[]);
  }

  async set(groupDn: string, role: AppRole, updatedBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO authz_group_role_map (group_dn, role, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (group_dn) DO UPDATE
       SET role = EXCLUDED.role, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [normalizeGroup(groupDn), role, updatedBy],
    );
  }

  async delete(groupDn: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM authz_group_role_map WHERE group_dn = $1`,
      [normalizeGroup(groupDn)],
    );
    return result.rowCount === 1;
  }
}
