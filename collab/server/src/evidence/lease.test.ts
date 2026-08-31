import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WRITE_LEASE_LOCK_SQL,
  EVIDENCE_WRITE_LEASE_UNLOCK_SQL,
  createPostgresEvidenceWriteLease,
  type EvidenceWriteLeaseClient,
} from "./lease.js";

describe("postgres evidence write lease", () => {
  it("uses the existing advisory key on one connection session through unlock", async () => {
    const queries: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    const client: EvidenceWriteLeaseClient = {
      async query(sql) {
        queries.push(sql);
        return undefined;
      },
      release(err) {
        releases.push(err);
      },
    };
    const acquire = createPostgresEvidenceWriteLease({
      connect: async () => client,
    });
    const release = await acquire();
    expect(queries).toEqual([EVIDENCE_WRITE_LEASE_LOCK_SQL]);
    expect(EVIDENCE_WRITE_LEASE_LOCK_SQL).toContain(
      "pg_advisory_lock(hashtextextended('contextdesk-evidence-write-v1', 0))",
    );
    await release();
    expect(queries).toEqual([
      EVIDENCE_WRITE_LEASE_LOCK_SQL,
      EVIDENCE_WRITE_LEASE_UNLOCK_SQL,
    ]);
    expect(releases).toEqual([undefined]);
  });

  it("releases the session client when lock acquisition fails", async () => {
    const releases: Array<Error | boolean | undefined> = [];
    const failure = new Error("lock failed");
    const client: EvidenceWriteLeaseClient = {
      async query() {
        throw failure;
      },
      release(err) {
        releases.push(err);
      },
    };
    const acquire = createPostgresEvidenceWriteLease({
      connect: async () => client,
    });
    await expect(acquire()).rejects.toBe(failure);
    expect(releases).toEqual([failure]);
  });
});
