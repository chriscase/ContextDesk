import { describe, expect, it, vi } from "vitest";
import type { SoftwareImpactRow } from "./store.js";
import {
  DuplicateSoftwareImpactError,
  PgSoftwareImpactStore,
  SoftwareImpactNotFoundError,
  SoftwareImpactReleasedError,
} from "./store.js";

const row: SoftwareImpactRow = {
  id: "11111111-1111-4111-8111-111111111111",
  caseId: "22222222-2222-4222-8222-222222222222",
  productName: "Synthetic Checkout Service",
  version: "7.4",
  build: "2026.08.26-rc1",
  component: "Inventory reservation",
  environment: "Staging",
  status: "suspected",
  note: "The reservation request waits.",
  state: "active",
  recordedAt: "2026-08-26T12:00:00.000Z",
  recordedBy: "local:demo",
  recordedByUsername: "demo",
  updatedAt: "2026-08-26T12:00:00.000Z",
  releasedAt: null,
};

function pgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    case_id: row.caseId,
    product_name: row.productName,
    version: row.version,
    build: row.build,
    component: row.component,
    environment: row.environment,
    status: row.status,
    note: row.note,
    state: row.state,
    recorded_at: new Date(row.recordedAt),
    recorded_by: row.recordedBy,
    recorded_by_username: row.recordedByUsername,
    updated_at: new Date(row.updatedAt),
    released_at: row.releasedAt,
    ...overrides,
  };
}

describe("PgSoftwareImpactStore", () => {
  it("maps hosted rows and preserves recording order in list queries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [pgRow()], rowCount: 1 });
    const store = new PgSoftwareImpactStore({ query });

    await expect(store.list(row.caseId)).resolves.toEqual([row]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY recorded_at ASC, id ASC"),
      [row.caseId],
    );
  });

  it("translates the database active-identity race into the domain duplicate", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce({ code: "23505" })
      .mockResolvedValueOnce({ rows: [pgRow()], rowCount: 1 });
    const store = new PgSoftwareImpactStore({ query });

    await expect(store.insert(row)).rejects.toEqual(
      expect.objectContaining({
        constructor: DuplicateSoftwareImpactError,
        existingId: row.id,
      }),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("distinguishes missing rows from released rows for state changes", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [pgRow({ state: "released", released_at: new Date() })], rowCount: 1 });
    const store = new PgSoftwareImpactStore({ query });

    await expect(store.updateStatus(row.id, "confirmed", "", row.updatedAt)).rejects.toBeInstanceOf(
      SoftwareImpactNotFoundError,
    );
    await expect(store.release(row.id, row.updatedAt)).rejects.toBeInstanceOf(
      SoftwareImpactReleasedError,
    );
  });
});
