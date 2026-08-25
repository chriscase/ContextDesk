import type { Capability, LocalCapabilityGrantV1 } from "@cd-collab/contracts";
import type { Pool } from "pg";

export interface LocalGrantStore {
  list(userId: string): Promise<LocalCapabilityGrantV1[]>;
  grant(userId: string, capability: Capability, grantedBy: string): Promise<"granted" | "already_granted">;
  revoke(userId: string, capability: Capability): Promise<"revoked" | "not_granted">;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryLocalGrantStore implements LocalGrantStore {
  private readonly byUser = new Map<string, Map<Capability, LocalCapabilityGrantV1>>();

  capture(): unknown {
    return {
      byUser: [...this.byUser.entries()].map(([userId, grants]) => [userId, [...grants.entries()]]),
    };
  }

  restore(snapshot: unknown): void {
    const state = snapshot as { byUser: [string, [Capability, LocalCapabilityGrantV1][]][] };
    this.byUser.clear();
    for (const [userId, grants] of state.byUser) {
      this.byUser.set(userId, new Map(grants));
    }
  }

  async list(userId: string): Promise<LocalCapabilityGrantV1[]> {
    const grants = this.byUser.get(userId);
    if (!grants) return [];
    return [...grants.values()].sort((a, b) => a.capability.localeCompare(b.capability));
  }

  async grant(
    userId: string,
    capability: Capability,
    grantedBy: string,
  ): Promise<"granted" | "already_granted"> {
    const grants = this.byUser.get(userId) ?? new Map<Capability, LocalCapabilityGrantV1>();
    if (grants.has(capability)) return "already_granted";
    grants.set(capability, { capability, grantedBy, grantedAt: nowIso() });
    this.byUser.set(userId, grants);
    return "granted";
  }

  async revoke(userId: string, capability: Capability): Promise<"revoked" | "not_granted"> {
    const grants = this.byUser.get(userId);
    if (!grants?.has(capability)) return "not_granted";
    grants.delete(capability);
    return "revoked";
  }
}

export class PgLocalGrantStore implements LocalGrantStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async list(userId: string): Promise<LocalCapabilityGrantV1[]> {
    const result = await this.pool.query(
      `SELECT capability, granted_by, granted_at FROM user_capability_grants
       WHERE user_id = $1 ORDER BY capability ASC`,
      [userId],
    );
    return (result.rows as { capability: Capability; granted_by: string; granted_at: Date }[]).map(
      (row) => ({
        capability: row.capability,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at.toISOString(),
      }),
    );
  }

  async grant(
    userId: string,
    capability: Capability,
    grantedBy: string,
  ): Promise<"granted" | "already_granted"> {
    const result = await this.pool.query(
      `INSERT INTO user_capability_grants (user_id, capability, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, capability) DO NOTHING`,
      [userId, capability, grantedBy],
    );
    return result.rowCount === 1 ? "granted" : "already_granted";
  }

  async revoke(userId: string, capability: Capability): Promise<"revoked" | "not_granted"> {
    const result = await this.pool.query(
      `DELETE FROM user_capability_grants WHERE user_id = $1 AND capability = $2`,
      [userId, capability],
    );
    return result.rowCount === 1 ? "revoked" : "not_granted";
  }
}
