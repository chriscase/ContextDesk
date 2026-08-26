/**
 * Investigation-scoped software-impact persistence.
 *
 * Memory is the local/demo store. SQLite wraps this object. PostgreSQL is
 * intentionally omitted in this slice so the write set does not race other
 * lanes for migration 020.
 */
import { randomUUID } from "node:crypto";
import type {
  SoftwareImpactIdentityV1,
  SoftwareImpactState,
  SoftwareImpactStatus,
  SoftwareImpactV1,
} from "@cd-collab/contracts";
import { SOFTWARE_IMPACT_SCHEMA_ID, softwareImpactIdentityKey } from "@cd-collab/contracts";

export interface SoftwareImpactRow {
  id: string;
  caseId: string;
  productName: string;
  version: string;
  build: string;
  component: string;
  environment: string;
  status: SoftwareImpactStatus;
  note: string;
  state: SoftwareImpactState;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface SoftwareImpactStore {
  list(caseId: string): Promise<SoftwareImpactRow[]>;
  listAll(): Promise<SoftwareImpactRow[]>;
  get(id: string): Promise<SoftwareImpactRow | null>;
  findActiveIdentity(caseId: string, identity: SoftwareImpactIdentityV1): Promise<SoftwareImpactRow | null>;
  insert(row: SoftwareImpactRow): Promise<void>;
  updateStatus(id: string, status: SoftwareImpactStatus, note: string, updatedAt: string): Promise<void>;
  release(id: string, releasedAt: string): Promise<void>;
}

export function newSoftwareImpactId(): string {
  return randomUUID();
}

export function toSoftwareImpactV1(row: SoftwareImpactRow): SoftwareImpactV1 {
  return {
    schemaId: SOFTWARE_IMPACT_SCHEMA_ID,
    id: row.id,
    investigationId: row.caseId,
    productName: row.productName,
    version: row.version,
    build: row.build,
    component: row.component,
    environment: row.environment,
    status: row.status,
    note: row.note,
    state: row.state,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    recordedByUsername: row.recordedByUsername,
    updatedAt: row.updatedAt,
    releasedAt: row.releasedAt,
  };
}

export class DuplicateSoftwareImpactError extends Error {
  constructor(readonly existingId: string) {
    super("software impact already recorded");
    this.name = "DuplicateSoftwareImpactError";
  }
}

export class SoftwareImpactNotFoundError extends Error {
  constructor() {
    super("software impact not found");
    this.name = "SoftwareImpactNotFoundError";
  }
}

export class SoftwareImpactReleasedError extends Error {
  constructor() {
    super("software impact is released");
    this.name = "SoftwareImpactReleasedError";
  }
}

export class InvestigationNotVisibleError extends Error {
  constructor() {
    super("investigation not found");
    this.name = "InvestigationNotVisibleError";
  }
}

export class MemorySoftwareImpactStore implements SoftwareImpactStore {
  private readonly rows = new Map<string, SoftwareImpactRow>();

  capture(): unknown {
    return structuredClone([...this.rows.entries()]);
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as [string, SoftwareImpactRow][];
    this.rows.clear();
    for (const [id, value] of dump ?? []) this.rows.set(id, value);
  }

  async list(caseId: string): Promise<SoftwareImpactRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }));
  }

  async listAll(): Promise<SoftwareImpactRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async get(id: string): Promise<SoftwareImpactRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findActiveIdentity(
    caseId: string,
    identity: SoftwareImpactIdentityV1,
  ): Promise<SoftwareImpactRow | null> {
    const key = softwareImpactIdentityKey(identity);
    for (const row of this.rows.values()) {
      if (row.caseId !== caseId || row.state !== "active") continue;
      if (softwareImpactIdentityKey(row) === key) return { ...row };
    }
    return null;
  }

  async insert(row: SoftwareImpactRow): Promise<void> {
    const existing = await this.findActiveIdentity(row.caseId, row);
    if (existing) throw new DuplicateSoftwareImpactError(existing.id);
    this.rows.set(row.id, { ...row });
  }

  async updateStatus(
    id: string,
    status: SoftwareImpactStatus,
    note: string,
    updatedAt: string,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new SoftwareImpactNotFoundError();
    if (row.state !== "active") throw new SoftwareImpactReleasedError();
    this.rows.set(id, { ...row, status, note, updatedAt });
  }

  async release(id: string, releasedAt: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new SoftwareImpactNotFoundError();
    if (row.state !== "active") throw new SoftwareImpactReleasedError();
    this.rows.set(id, { ...row, state: "released", releasedAt, updatedAt: releasedAt });
  }
}
