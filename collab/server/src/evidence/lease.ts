/**
 * PostgreSQL session advisory lease for evidence writes.
 *
 * Preserves the existing key and connection-session semantics:
 * `pg_advisory_lock(hashtextextended('contextdesk-evidence-write-v1', 0))`
 * on a dedicated pool client, unlocked on the same session before release.
 * This is not multi-app replica safety and is not wired into the process
 * entrypoint from this lane.
 */

export const EVIDENCE_WRITE_LEASE_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtextextended('contextdesk-evidence-write-v1', 0))";
export const EVIDENCE_WRITE_LEASE_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtextextended('contextdesk-evidence-write-v1', 0))";

export interface EvidenceWriteLeaseClient {
  query(sql: string): Promise<unknown>;
  release(err?: Error | boolean): void;
}

export interface EvidenceWriteLeasePool {
  connect(): Promise<EvidenceWriteLeaseClient>;
}

export type EvidenceWriteLeaseRelease = () => void | Promise<void>;

export function createPostgresEvidenceWriteLease(
  pool: EvidenceWriteLeasePool,
): () => Promise<EvidenceWriteLeaseRelease> {
  return async () => {
    const client = await pool.connect();
    try {
      await client.query(EVIDENCE_WRITE_LEASE_LOCK_SQL);
      return async () => {
        try {
          await client.query(EVIDENCE_WRITE_LEASE_UNLOCK_SQL);
        } finally {
          client.release();
        }
      };
    } catch (error) {
      client.release(error instanceof Error ? error : undefined);
      throw error;
    }
  };
}
