import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ENTITY_SCHEMA_ID,
  INVOLVEMENT_SCHEMA_ID,
  type EntityKind,
  type EntityLifecycle,
  type InvestigationEntityV1,
  type InvestigationInvolvementV1,
  type InvolvementRelationship,
  type InvolvementState,
  type OccurredAtPrecision,
  type OccurredAtZone,
  type PrivacyClass,
} from "@cd-collab/contracts";

export interface EntityRow {
  id: string;
  kind: EntityKind;
  label: string;
  profileSummary: string;
  profileReference: string;
  privacyClass: PrivacyClass;
  lifecycle: EntityLifecycle;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface InvolvementRow {
  id: string;
  caseId: string;
  entityId: string;
  relationship: InvolvementRelationship;
  state: InvolvementState;
  note: string;
  /** Immutable historical attribution, captured at link time. */
  recordedLabel: string;
  recordedKind: EntityKind;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  releasedAt: string | null;
}

export interface EntityUpdate {
  label: string;
  profileSummary: string;
  profileReference: string;
  privacyClass: PrivacyClass;
  updatedAt: string;
}

export interface EntityStore {
  listEntities(): Promise<EntityRow[]>;
  getEntity(id: string): Promise<EntityRow | null>;
  /** Reuse check. Retired rows never block a fresh registration of the name. */
  findActiveByLabel(kind: EntityKind, label: string): Promise<EntityRow | null>;
  insertEntity(row: EntityRow): Promise<void>;
  updateEntity(id: string, patch: EntityUpdate): Promise<void>;
  setEntityLifecycle(id: string, lifecycle: EntityLifecycle, updatedAt: string): Promise<void>;
  listInvolvements(caseId: string): Promise<InvolvementRow[]>;
  /** Every link, for the entity-to-investigation index behind list filters. */
  listAllInvolvements(): Promise<InvolvementRow[]>;
  getInvolvement(id: string): Promise<InvolvementRow | null>;
  findActiveInvolvement(
    caseId: string,
    entityId: string,
    relationship: InvolvementRelationship,
  ): Promise<InvolvementRow | null>;
  insertInvolvement(row: InvolvementRow): Promise<void>;
  releaseInvolvement(id: string, releasedAt: string): Promise<void>;
}

export type Queryable = Pick<Pool, "query">;

export function newEntityId(): string {
  return randomUUID();
}

export function normalizedLabelKey(kind: EntityKind, label: string): string {
  return `${kind}::${label.trim().toLowerCase()}`;
}

export function toEntityV1(row: EntityRow): InvestigationEntityV1 {
  const profile =
    row.profileSummary === "" && row.profileReference === ""
      ? null
      : { summary: row.profileSummary, reference: row.profileReference };
  return {
    schemaId: ENTITY_SCHEMA_ID,
    id: row.id,
    kind: row.kind,
    label: row.label,
    profile,
    privacyClass: row.privacyClass,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
  };
}

/**
 * Projects a link for one reader. `recordedLabel`/`recordedKind` are what the
 * investigation said at link time and never move; the current registry values
 * travel beside them so a reader sees drift instead of a silent rewrite. An
 * entity the reader cannot resolve leaves the current fields null rather than
 * inventing a placeholder.
 */
export function toInvolvementV1(
  row: InvolvementRow,
  entity: EntityRow | null,
): InvestigationInvolvementV1 {
  return {
    schemaId: INVOLVEMENT_SCHEMA_ID,
    id: row.id,
    investigationId: row.caseId,
    entityId: row.entityId,
    relationship: row.relationship,
    state: row.state,
    note: row.note,
    recordedLabel: row.recordedLabel,
    recordedKind: row.recordedKind,
    currentLabel: entity?.label ?? null,
    currentKind: entity?.kind ?? null,
    currentLifecycle: entity?.lifecycle ?? null,
    occurredAt: row.occurredAt,
    occurredAtPrecision: row.occurredAtPrecision,
    occurredAtZone: row.occurredAtZone,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    recordedByUsername: row.recordedByUsername,
    releasedAt: row.releasedAt,
  };
}

export class DuplicateEntityError extends Error {
  constructor(readonly existingId: string) {
    super("entity already exists");
    this.name = "DuplicateEntityError";
  }
}

export class DuplicateInvolvementError extends Error {
  constructor(readonly existingId: string) {
    super("involvement already recorded");
    this.name = "DuplicateInvolvementError";
  }
}

export class MemoryEntityStore implements EntityStore {
  private readonly entities = new Map<string, EntityRow>();
  private readonly involvements = new Map<string, InvolvementRow>();

  capture(): unknown {
    return structuredClone({
      entities: [...this.entities.entries()],
      involvements: [...this.involvements.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as {
      entities: [string, EntityRow][];
      involvements: [string, InvolvementRow][];
    };
    this.entities.clear();
    this.involvements.clear();
    for (const [id, value] of dump.entities ?? []) this.entities.set(id, value);
    for (const [id, value] of dump.involvements ?? []) this.involvements.set(id, value);
  }

  async listEntities(): Promise<EntityRow[]> {
    return [...this.entities.values()].map((row) => ({ ...row }));
  }

  async getEntity(id: string): Promise<EntityRow | null> {
    const row = this.entities.get(id);
    return row ? { ...row } : null;
  }

  async findActiveByLabel(kind: EntityKind, label: string): Promise<EntityRow | null> {
    const key = normalizedLabelKey(kind, label);
    for (const row of this.entities.values()) {
      if (row.lifecycle !== "active") continue;
      if (normalizedLabelKey(row.kind, row.label) === key) return { ...row };
    }
    return null;
  }

  async insertEntity(row: EntityRow): Promise<void> {
    const existing = await this.findActiveByLabel(row.kind, row.label);
    if (existing) throw new DuplicateEntityError(existing.id);
    this.entities.set(row.id, { ...row });
  }

  async updateEntity(id: string, patch: EntityUpdate): Promise<void> {
    const row = this.entities.get(id);
    if (!row) throw new Error("entity not found");
    const clash = await this.findActiveByLabel(row.kind, patch.label);
    if (clash && clash.id !== id) throw new DuplicateEntityError(clash.id);
    row.label = patch.label;
    row.profileSummary = patch.profileSummary;
    row.profileReference = patch.profileReference;
    row.privacyClass = patch.privacyClass;
    row.updatedAt = patch.updatedAt;
  }

  async setEntityLifecycle(
    id: string,
    lifecycle: EntityLifecycle,
    updatedAt: string,
  ): Promise<void> {
    const row = this.entities.get(id);
    if (!row) throw new Error("entity not found");
    row.lifecycle = lifecycle;
    row.updatedAt = updatedAt;
  }

  async listInvolvements(caseId: string): Promise<InvolvementRow[]> {
    return [...this.involvements.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }));
  }

  async listAllInvolvements(): Promise<InvolvementRow[]> {
    return [...this.involvements.values()].map((row) => ({ ...row }));
  }

  async getInvolvement(id: string): Promise<InvolvementRow | null> {
    const row = this.involvements.get(id);
    return row ? { ...row } : null;
  }

  async findActiveInvolvement(
    caseId: string,
    entityId: string,
    relationship: InvolvementRelationship,
  ): Promise<InvolvementRow | null> {
    for (const row of this.involvements.values()) {
      if (
        row.caseId === caseId &&
        row.entityId === entityId &&
        row.relationship === relationship &&
        row.state === "active"
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async insertInvolvement(row: InvolvementRow): Promise<void> {
    const existing = await this.findActiveInvolvement(row.caseId, row.entityId, row.relationship);
    if (existing) throw new DuplicateInvolvementError(existing.id);
    this.involvements.set(row.id, { ...row });
  }

  async releaseInvolvement(id: string, releasedAt: string): Promise<void> {
    const row = this.involvements.get(id);
    if (!row) throw new Error("involvement not found");
    row.state = "released";
    row.releasedAt = releasedAt;
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asEntity(row: Record<string, unknown>): EntityRow {
  return {
    id: String(row.id),
    kind: row.kind as EntityKind,
    label: String(row.label),
    profileSummary: text(row.profile_summary),
    profileReference: text(row.profile_reference),
    privacyClass: row.privacy_class as PrivacyClass,
    lifecycle: row.lifecycle as EntityLifecycle,
    createdAt: instant(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: instant(row.updated_at),
  };
}

function asInvolvement(row: Record<string, unknown>): InvolvementRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    entityId: String(row.entity_id),
    relationship: row.relationship as InvolvementRelationship,
    state: row.state as InvolvementState,
    note: text(row.note),
    recordedLabel: String(row.recorded_label),
    recordedKind: row.recorded_kind as EntityKind,
    occurredAt: nullableText(row.occurred_at),
    occurredAtPrecision: row.occurred_at_precision as OccurredAtPrecision,
    occurredAtZone: row.occurred_at_zone as OccurredAtZone,
    recordedAt: instant(row.recorded_at),
    recordedBy: String(row.recorded_by),
    recordedByUsername: String(row.recorded_by_username),
    releasedAt: nullableInstant(row.released_at),
  };
}

/** Unique-violation SQLSTATE, used to translate the partial indexes above. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

export class PgEntityStore implements EntityStore {
  constructor(private readonly db: Queryable) {}

  async listEntities(): Promise<EntityRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_entities ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => asEntity(row as Record<string, unknown>));
  }

  async getEntity(id: string): Promise<EntityRow | null> {
    const result = await this.db.query(`SELECT * FROM investigation_entities WHERE id = $1`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asEntity(row) : null;
  }

  async findActiveByLabel(kind: EntityKind, label: string): Promise<EntityRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_entities
       WHERE lifecycle = 'active' AND kind = $1 AND lower(label) = lower($2)`,
      [kind, label.trim()],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asEntity(row) : null;
  }

  async insertEntity(row: EntityRow): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO investigation_entities (
           id, kind, label, profile_summary, profile_reference, privacy_class,
           lifecycle, created_at, created_by, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.kind,
          row.label,
          row.profileSummary,
          row.profileReference,
          row.privacyClass,
          row.lifecycle,
          row.createdAt,
          row.createdBy,
          row.updatedAt,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findActiveByLabel(row.kind, row.label);
      throw new DuplicateEntityError(existing?.id ?? row.id);
    }
  }

  async updateEntity(id: string, patch: EntityUpdate): Promise<void> {
    try {
      const result = await this.db.query(
        `UPDATE investigation_entities
         SET label = $2, profile_summary = $3, profile_reference = $4,
             privacy_class = $5, updated_at = $6
         WHERE id = $1`,
        [
          id,
          patch.label,
          patch.profileSummary,
          patch.profileReference,
          patch.privacyClass,
          patch.updatedAt,
        ],
      );
      if (result.rowCount === 0) throw new Error("entity not found");
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findActiveByLabel(
        (await this.getEntity(id))?.kind ?? "other",
        patch.label,
      );
      throw new DuplicateEntityError(existing?.id ?? id);
    }
  }

  async setEntityLifecycle(
    id: string,
    lifecycle: EntityLifecycle,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE investigation_entities SET lifecycle = $2, updated_at = $3 WHERE id = $1`,
      [id, lifecycle, updatedAt],
    );
    if (result.rowCount === 0) throw new Error("entity not found");
  }

  async listInvolvements(caseId: string): Promise<InvolvementRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_involvements
       WHERE case_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asInvolvement(row as Record<string, unknown>));
  }

  async listAllInvolvements(): Promise<InvolvementRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_involvements ORDER BY recorded_at ASC, id ASC`,
    );
    return result.rows.map((row) => asInvolvement(row as Record<string, unknown>));
  }

  async getInvolvement(id: string): Promise<InvolvementRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_involvements WHERE id = $1`,
      [id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asInvolvement(row) : null;
  }

  async findActiveInvolvement(
    caseId: string,
    entityId: string,
    relationship: InvolvementRelationship,
  ): Promise<InvolvementRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_involvements
       WHERE case_id = $1 AND entity_id = $2 AND relationship = $3 AND state = 'active'`,
      [caseId, entityId, relationship],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asInvolvement(row) : null;
  }

  async insertInvolvement(row: InvolvementRow): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO investigation_involvements (
           id, case_id, entity_id, relationship, state, note,
           recorded_label, recorded_kind, occurred_at, occurred_at_precision,
           occurred_at_zone, recorded_at, recorded_by, recorded_by_username, released_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id,
          row.caseId,
          row.entityId,
          row.relationship,
          row.state,
          row.note,
          row.recordedLabel,
          row.recordedKind,
          row.occurredAt,
          row.occurredAtPrecision,
          row.occurredAtZone,
          row.recordedAt,
          row.recordedBy,
          row.recordedByUsername,
          row.releasedAt,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findActiveInvolvement(
        row.caseId,
        row.entityId,
        row.relationship,
      );
      throw new DuplicateInvolvementError(existing?.id ?? row.id);
    }
  }

  async releaseInvolvement(id: string, releasedAt: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE investigation_involvements
       SET state = 'released', released_at = $2
       WHERE id = $1 AND state = 'active'`,
      [id, releasedAt],
    );
    if (result.rowCount === 0) throw new Error("involvement not found");
  }
}
