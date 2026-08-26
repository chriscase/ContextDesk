import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  RESOLUTION_SCHEMA_ID,
  type CaseStatus,
  type InvestigationProvenanceClassV1,
  type InvestigationResolutionV1,
  type OccurredAtPrecision,
  type OccurredAtZone,
  type ResolutionBasis,
} from "@cd-collab/contracts";

export interface ResolutionRow {
  id: string;
  caseId: string;
  revision: number;
  predecessorRevision: number | null;
  basis: ResolutionBasis;
  provenance: InvestigationProvenanceClassV1;
  status: CaseStatus;
  rationale: string;
  unknowns: string[];
  experimentDecisionId: string | null;
  exceptionReason: string | null;
  citedArtifactIds: string[];
  citedContributionIds: string[];
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  supersededAt: string | null;
}

export interface ResolutionStore {
  /** Newest revision first. */
  listByCase(caseId: string): Promise<ResolutionRow[]>;
  activeForCase(caseId: string): Promise<ResolutionRow | null>;
  insert(row: ResolutionRow): Promise<void>;
  supersede(id: string, supersededAt: string): Promise<void>;
}

export type Queryable = Pick<Pool, "query">;

export function newResolutionId(): string {
  return randomUUID();
}

export class ResolutionRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("resolution revision conflict");
    this.name = "ResolutionRevisionConflictError";
  }
}

export function toResolutionV1(row: ResolutionRow): InvestigationResolutionV1 {
  return {
    schemaId: RESOLUTION_SCHEMA_ID,
    id: row.id,
    investigationId: row.caseId,
    revision: row.revision,
    predecessorRevision: row.predecessorRevision,
    basis: row.basis,
    provenance: row.provenance,
    status: row.status,
    rationale: row.rationale,
    unknowns: [...row.unknowns],
    experimentDecisionId: row.experimentDecisionId,
    exceptionReason: row.exceptionReason,
    citedArtifactIds: [...row.citedArtifactIds],
    citedContributionIds: [...row.citedContributionIds],
    occurredAt: row.occurredAt,
    occurredAtPrecision: row.occurredAtPrecision,
    occurredAtZone: row.occurredAtZone,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    recordedByUsername: row.recordedByUsername,
    supersededAt: row.supersededAt,
  };
}

function byRevisionDesc(a: ResolutionRow, b: ResolutionRow): number {
  return b.revision - a.revision;
}

export class MemoryResolutionStore implements ResolutionStore {
  private readonly resolutions = new Map<string, ResolutionRow>();

  capture(): unknown {
    return structuredClone({ resolutions: [...this.resolutions.entries()] });
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as { resolutions: [string, ResolutionRow][] };
    this.resolutions.clear();
    for (const [id, value] of dump.resolutions ?? []) this.resolutions.set(id, value);
  }

  async listByCase(caseId: string): Promise<ResolutionRow[]> {
    return [...this.resolutions.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row, unknowns: [...row.unknowns] }))
      .sort(byRevisionDesc);
  }

  async activeForCase(caseId: string): Promise<ResolutionRow | null> {
    const active = (await this.listByCase(caseId)).find((row) => row.supersededAt === null);
    return active ?? null;
  }

  async insert(row: ResolutionRow): Promise<void> {
    const existing = await this.listByCase(row.caseId);
    if (existing.some((item) => item.revision === row.revision)) {
      throw new ResolutionRevisionConflictError(existing[0]?.revision ?? 0);
    }
    if (row.supersededAt === null && existing.some((item) => item.supersededAt === null)) {
      throw new ResolutionRevisionConflictError(existing[0]?.revision ?? 0);
    }
    this.resolutions.set(row.id, { ...row, unknowns: [...row.unknowns] });
  }

  async supersede(id: string, supersededAt: string): Promise<void> {
    const row = this.resolutions.get(id);
    if (!row) throw new Error("resolution not found");
    // Insert-only: superseding is the one permitted transition, and only once.
    if (row.supersededAt !== null) return;
    row.supersededAt = supersededAt;
  }
}

function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asResolution(row: Record<string, unknown>): ResolutionRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    revision: Number(row.revision),
    predecessorRevision:
      row.predecessor_revision === null || row.predecessor_revision === undefined
        ? null
        : Number(row.predecessor_revision),
    basis: row.basis as ResolutionBasis,
    provenance: row.provenance as InvestigationProvenanceClassV1,
    status: row.status as CaseStatus,
    rationale: String(row.rationale),
    unknowns: stringList(row.unknowns),
    experimentDecisionId:
      row.experiment_decision_id === null || row.experiment_decision_id === undefined
        ? null
        : String(row.experiment_decision_id),
    exceptionReason:
      row.exception_reason === null || row.exception_reason === undefined
        ? null
        : String(row.exception_reason),
    citedArtifactIds: stringList(row.cited_artifact_ids),
    citedContributionIds: stringList(row.cited_contribution_ids),
    occurredAt:
      row.occurred_at === null || row.occurred_at === undefined ? null : String(row.occurred_at),
    occurredAtPrecision: row.occurred_at_precision as OccurredAtPrecision,
    occurredAtZone: row.occurred_at_zone as OccurredAtZone,
    recordedAt: instant(row.recorded_at),
    recordedBy: String(row.recorded_by),
    recordedByUsername: String(row.recorded_by_username),
    supersededAt: nullableInstant(row.superseded_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

export class PgResolutionStore implements ResolutionStore {
  constructor(private readonly db: Queryable) {}

  async listByCase(caseId: string): Promise<ResolutionRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_resolutions WHERE case_id = $1 ORDER BY revision DESC`,
      [caseId],
    );
    return result.rows.map((row) => asResolution(row as Record<string, unknown>));
  }

  async activeForCase(caseId: string): Promise<ResolutionRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_resolutions
       WHERE case_id = $1 AND superseded_at IS NULL
       ORDER BY revision DESC LIMIT 1`,
      [caseId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asResolution(row) : null;
  }

  async insert(row: ResolutionRow): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO investigation_resolutions (
           id, case_id, revision, predecessor_revision, basis, provenance, status,
           rationale, unknowns, experiment_decision_id, exception_reason,
           cited_artifact_ids, cited_contribution_ids,
           occurred_at, occurred_at_precision, occurred_at_zone,
           recorded_at, recorded_by, recorded_by_username, superseded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb,
                   $14, $15, $16, $17, $18, $19, $20)`,
        [
          row.id,
          row.caseId,
          row.revision,
          row.predecessorRevision,
          row.basis,
          row.provenance,
          row.status,
          row.rationale,
          JSON.stringify(row.unknowns),
          row.experimentDecisionId,
          row.exceptionReason,
          JSON.stringify(row.citedArtifactIds),
          JSON.stringify(row.citedContributionIds),
          row.occurredAt,
          row.occurredAtPrecision,
          row.occurredAtZone,
          row.recordedAt,
          row.recordedBy,
          row.recordedByUsername,
          row.supersededAt,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const current = await this.activeForCase(row.caseId);
      throw new ResolutionRevisionConflictError(current?.revision ?? row.revision - 1);
    }
  }

  async supersede(id: string, supersededAt: string): Promise<void> {
    await this.db.query(
      `UPDATE investigation_resolutions
       SET superseded_at = $2
       WHERE id = $1 AND superseded_at IS NULL`,
      [id, supersededAt],
    );
  }
}
