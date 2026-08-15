import { describe, expect, it } from "vitest";
import { adminUrl, withDisposableDb } from "../test/disposable-db.js";
import { migrateDown, migrateUp } from "./migrate.js";

describe.skipIf(!adminUrl())("migrations", () => {
  it("applies and rolls back baseline then auth/audit migrations", async () => {
    await withDisposableDb(async (client) => {
      const up = await migrateUp(client);
      expect(up.applied).toContain("001_baseline");
      expect(up.applied).toContain("002_auth_audit");
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_events'`,
      );
      expect(tables.rows).toHaveLength(1);
      const first = await migrateDown(client);
      expect(first.rolledBack).toBe("002_auth_audit");
      const second = await migrateDown(client);
      expect(second.rolledBack).toBe("001_baseline");
      const gone = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('evidence_file_references', 'audit_events')`,
      );
      expect(gone.rows).toHaveLength(0);
    });
  });

  it("dry-run lists pending SQL without applying", async () => {
    await withDisposableDb(async (client) => {
      const dry = await migrateUp(client, { dryRun: true });
      expect(dry.pending).toContain("001_baseline");
      expect(dry.pending).toContain("002_auth_audit");
      expect(dry.applied).toHaveLength(0);
      expect(dry.sql.some((s) => s.includes("evidence_file_references"))).toBe(
        true,
      );
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(tables.rows).toHaveLength(0);
    });
  });
});
