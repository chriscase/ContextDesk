import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthIdentity } from "./adapter.js";

export interface SessionRecord {
  id: string;
  identity: AuthIdentity;
  groups: string[];
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  create(input: {
    identity: AuthIdentity;
    groups: string[];
    ttlMs: number;
  }): Promise<{ token: string; record: SessionRecord }>;
  getByToken(token: string): Promise<SessionRecord | null>;
  touch(id: string): Promise<void>;
  revoke(id: string): Promise<void>;
  /** Revoke every unexpired session for this identity (suspend/disable). */
  revokeAllForIdentity(identityId: string): Promise<number>;
}

export interface SessionPolicy {
  ttlMs: number;
  idleMs: number;
}

export const defaultSessionPolicy: SessionPolicy = {
  ttlMs: 8 * 60 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class MemorySessionStore implements SessionStore {
  private readonly byHash = new Map<string, SessionRecord & { tokenHash: string }>();

  async create(input: {
    identity: AuthIdentity;
    groups: string[];
    ttlMs: number;
  }): Promise<{ token: string; record: SessionRecord }> {
    const token = newToken();
    const now = new Date();
    const record: SessionRecord & { tokenHash: string } = {
      id: randomUUID(),
      identity: input.identity,
      groups: [...input.groups],
      expiresAt: new Date(now.getTime() + input.ttlMs),
      lastSeenAt: now,
      revokedAt: null,
      tokenHash: hashToken(token),
    };
    this.byHash.set(record.tokenHash, record);
    return { token, record };
  }

  async getByToken(token: string): Promise<SessionRecord | null> {
    return this.byHash.get(hashToken(token)) ?? null;
  }

  async touch(id: string): Promise<void> {
    for (const row of this.byHash.values()) {
      if (row.id === id) {
        row.lastSeenAt = new Date();
        return;
      }
    }
  }

  async revoke(id: string): Promise<void> {
    for (const row of this.byHash.values()) {
      if (row.id === id) {
        row.revokedAt = new Date();
        return;
      }
    }
  }

  async revokeAllForIdentity(identityId: string): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const row of this.byHash.values()) {
      if (row.identity.id === identityId && !row.revokedAt) {
        row.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async create(input: {
    identity: AuthIdentity;
    groups: string[];
    ttlMs: number;
  }): Promise<{ token: string; record: SessionRecord }> {
    const token = newToken();
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    await this.pool.query(
      `INSERT INTO sessions (
         id, token_hash, identity_id, username, display_name, groups, created_at, expires_at, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`,
      [
        id,
        hashToken(token),
        input.identity.id,
        input.identity.username,
        input.identity.displayName,
        input.groups,
        now,
        expiresAt,
      ],
    );
    return {
      token,
      record: {
        id,
        identity: input.identity,
        groups: [...input.groups],
        expiresAt,
        lastSeenAt: now,
        revokedAt: null,
      },
    };
  }

  async getByToken(token: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT id, identity_id, username, display_name, groups, expires_at, last_seen_at, revoked_at
       FROM sessions WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const row = result.rows[0] as
      | {
          id: string;
          identity_id: string;
          username: string;
          display_name: string;
          groups: string[];
          expires_at: Date;
          last_seen_at: Date;
          revoked_at: Date | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      identity: {
        id: row.identity_id,
        username: row.username,
        displayName: row.display_name,
      },
      groups: row.groups,
      expiresAt: new Date(row.expires_at),
      lastSeenAt: new Date(row.last_seen_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    };
  }

  async touch(id: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [
      id,
    ]);
  }

  async revoke(id: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [
      id,
    ]);
  }

  async revokeAllForIdentity(identityId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE identity_id = $1 AND revoked_at IS NULL`,
      [identityId],
    );
    return result.rowCount ?? 0;
  }
}

export function isSessionActive(
  record: SessionRecord,
  policy: SessionPolicy,
  now: Date = new Date(),
): boolean {
  if (record.revokedAt) return false;
  if (record.expiresAt.getTime() <= now.getTime()) return false;
  if (now.getTime() - record.lastSeenAt.getTime() > policy.idleMs) return false;
  return true;
}
