import type { SnapshotV1 } from "@cd-collab/contracts";

export interface SnapshotStore {
  insert(row: SnapshotV1): Promise<void>;
  get(snapshotId: string): Promise<SnapshotV1 | null>;
  findByFingerprint(caseId: string, fingerprint: string): Promise<SnapshotV1 | null>;
  listByCase(caseId: string): Promise<SnapshotV1[]>;
}

function cloneSnapshot(row: SnapshotV1): SnapshotV1 {
  return structuredClone(row);
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly byId = new Map<string, SnapshotV1>();
  private readonly idsByCase = new Map<string, string[]>();

  async insert(row: SnapshotV1): Promise<void> {
    if (this.byId.has(row.snapshotId)) {
      throw new Error("snapshot already exists");
    }
    this.byId.set(row.snapshotId, cloneSnapshot(row));
    const ids = this.idsByCase.get(row.caseId) ?? [];
    ids.push(row.snapshotId);
    this.idsByCase.set(row.caseId, ids);
  }

  async get(snapshotId: string): Promise<SnapshotV1 | null> {
    const row = this.byId.get(snapshotId);
    return row ? cloneSnapshot(row) : null;
  }

  async findByFingerprint(caseId: string, fingerprint: string): Promise<SnapshotV1 | null> {
    for (const id of this.idsByCase.get(caseId) ?? []) {
      const row = this.byId.get(id);
      if (row?.fingerprint === fingerprint) return cloneSnapshot(row);
    }
    return null;
  }

  async listByCase(caseId: string): Promise<SnapshotV1[]> {
    const rows: SnapshotV1[] = [];
    for (const id of this.idsByCase.get(caseId) ?? []) {
      const row = this.byId.get(id);
      if (row) rows.push(cloneSnapshot(row));
    }
    return rows.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.snapshotId.localeCompare(b.snapshotId),
    );
  }
}
