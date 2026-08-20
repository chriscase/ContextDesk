import {
  PRESENCE_SCHEMA_ID,
  type CasePresenceV1,
  type PresenceSurface,
} from "@cd-collab/contracts";
import type { Pool } from "pg";

const PRESENCE_TTL_MS = 45_000;
const PRESENCE_TTL_SECONDS = Math.floor(PRESENCE_TTL_MS / 1_000);

export interface PresenceActor {
  id: string;
  username: string;
}

export interface PresenceRecord {
  identityId: string;
  username: string;
  surface: PresenceSurface;
  lastSeenAt: number;
}

export interface PresenceBackend {
  touch(caseId: string, actor: PresenceActor, surface: PresenceSurface): Promise<void>;
  list(caseId: string, now?: number): Promise<PresenceRecord[]>;
}

export class MemoryPresenceBackend implements PresenceBackend {
  private readonly cases = new Map<string, Map<string, PresenceRecord>>();

  async touch(caseId: string, actor: PresenceActor, surface: PresenceSurface): Promise<void> {
    const members = this.cases.get(caseId) ?? new Map<string, PresenceRecord>();
    members.set(actor.id, {
      identityId: actor.id,
      username: actor.username,
      surface,
      lastSeenAt: Date.now(),
    });
    this.cases.set(caseId, members);
  }

  async list(caseId: string, now = Date.now()): Promise<PresenceRecord[]> {
    const members = this.cases.get(caseId);
    const fresh = [...(members?.values() ?? [])]
      .filter((member) => now - member.lastSeenAt <= PRESENCE_TTL_MS)
      .sort((a, b) => a.username.localeCompare(b.username) || a.identityId.localeCompare(b.identityId));
    if (members) {
      for (const identityId of members.keys()) {
        if (!fresh.some((member) => member.identityId === identityId)) members.delete(identityId);
      }
      if (members.size === 0) this.cases.delete(caseId);
    }
    return fresh;
  }
}

export class PgPresenceBackend implements PresenceBackend {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async touch(caseId: string, actor: PresenceActor, surface: PresenceSurface): Promise<void> {
    await this.pool.query(
      `INSERT INTO case_presence (case_id, identity_id, username, surface, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (case_id, identity_id) DO UPDATE SET
         username = EXCLUDED.username,
         surface = EXCLUDED.surface,
         last_seen_at = now()`,
      [caseId, actor.id, actor.username, surface],
    );
  }

  async list(caseId: string, now = Date.now()): Promise<PresenceRecord[]> {
    const result = await this.pool.query<{
      identity_id: string;
      username: string;
      surface: PresenceSurface;
      last_seen_at: Date | string;
    }>(
      `DELETE FROM case_presence
       WHERE case_id = $1 AND last_seen_at < now() - interval '45 seconds'
       RETURNING identity_id, username, surface, last_seen_at`,
      [caseId],
    );
    // A DELETE ... RETURNING result contains only expired rows. Fetch the
    // fresh set separately so the query remains portable to test doubles.
    void result;
    const fresh = await this.pool.query<{
      identity_id: string;
      username: string;
      surface: PresenceSurface;
      last_seen_at: Date | string;
    }>(
      `SELECT identity_id, username, surface, last_seen_at
       FROM case_presence WHERE case_id = $1
       ORDER BY username ASC, identity_id ASC`,
      [caseId],
    );
    return fresh.rows.map((row) => ({
      identityId: row.identity_id,
      username: row.username,
      surface: row.surface,
      lastSeenAt: row.last_seen_at instanceof Date
        ? row.last_seen_at.getTime()
        : Date.parse(row.last_seen_at),
    })).filter((row) => now - row.lastSeenAt <= PRESENCE_TTL_MS);
  }
}

/**
 * Presence is intentionally ephemeral. It is useful for collaboration but is
 * not a case fact, audit record, or evidence claim. A process restart simply
 * clears stale presence rather than manufacturing continuity.
 */
export class PresenceService {
  constructor(private readonly backend: PresenceBackend = new MemoryPresenceBackend()) {}

  async touch(caseId: string, actor: PresenceActor, surface: PresenceSurface): Promise<void> {
    await this.backend.touch(caseId, actor, surface);
  }

  async list(caseId: string, now = Date.now()): Promise<CasePresenceV1> {
    const fresh = await this.backend.list(caseId, now);
    return {
      schemaId: PRESENCE_SCHEMA_ID,
      caseId,
      ttlSeconds: PRESENCE_TTL_SECONDS,
      members: fresh.map((member) => ({
        identityId: member.identityId,
        username: member.username,
        surface: member.surface,
        lastSeenAt: new Date(member.lastSeenAt).toISOString(),
      })),
    };
  }
}

export const PRESENCE_TTL_SECONDS_PUBLIC = PRESENCE_TTL_SECONDS;
