import {
  ENTITY_LIST_SCHEMA_ID,
  INVOLVEMENT_INDEX_SCHEMA_ID,
  INVOLVEMENT_LIST_SCHEMA_ID,
  isEntityKind,
  isEntityLifecycle,
  isInvolvementRelationship,
  normalizeEntityLabel,
  normalizeEntityProfile,
  normalizeInvolvementNote,
  normalizeOccurredAt,
  type EntityKind,
  type InvestigationEntityListV1,
  type InvestigationEntityV1,
  type InvestigationInvolvementListV1,
  type InvestigationInvolvementV1,
  type InvolvementIndexV1,
  type InvolvementRelationship,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import {
  DuplicateEntityError,
  MemoryEntityStore,
  newEntityId,
  toEntityV1,
  toInvolvementV1,
  type EntityRow,
  type EntityStore,
  type InvolvementRow,
} from "./store.js";

export interface Actor {
  id: string;
  username: string;
}

/**
 * What this module needs from the investigation domain, and nothing more:
 * whether this reader may see an investigation, and a way to record that
 * something happened on it. Kept narrow so the registry never grows a path
 * into case content.
 */
export interface InvestigationGateway {
  getCase(
    id: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string; title: string } | null>;
  appendDomainTimeline(
    caseId: string,
    event: {
      kind: string;
      actor: Actor;
      targetId: string | null;
      clientTime: string | null;
      payload: unknown;
    },
  ): Promise<unknown>;
}

export class EntityNotFoundError extends Error {
  constructor() {
    super("entity not found");
    this.name = "EntityNotFoundError";
  }
}

export class RetiredEntityError extends Error {
  constructor() {
    super("entity is retired");
    this.name = "RetiredEntityError";
  }
}

export class InvestigationNotVisibleError extends Error {
  constructor() {
    super("investigation not found");
    this.name = "InvestigationNotVisibleError";
  }
}

export interface EntityFilter {
  kind?: string;
  lifecycle?: string;
  /** Case-insensitive substring of the label. */
  query?: string;
}

export interface EntityCreateInput {
  kind: string;
  label: unknown;
  profile?: unknown;
  privacyClass?: string;
}

export interface InvolvementInput {
  entityId: string;
  relationship: string;
  note?: unknown;
  occurredAt?: unknown;
  occurredAtPrecision?: unknown;
  occurredAtZone?: unknown;
}

function assertPrivacyClass(value: unknown): PrivacyClass {
  if (value === undefined || value === null) return "owner_only";
  if (value === "owner_only" || value === "share_safe") return value;
  throw new Error("unknown privacy class");
}

/**
 * The reusable entity registry and the links that involve entities in
 * investigations.
 *
 * Registry writes are global; involvement writes are investigation-scoped and
 * always re-check that the caller can see the investigation. Neither path ever
 * reads or writes evidence, log, email, or chat content — see the module
 * contract for why that boundary is load-bearing.
 */
export class EntityService {
  private readonly store: EntityStore;
  private readonly audit: AuditStore | undefined;
  private readonly investigations: InvestigationGateway | undefined;

  constructor(deps: {
    store?: EntityStore;
    audit?: AuditStore;
    investigations?: InvestigationGateway;
  } = {}) {
    this.store = deps.store ?? new MemoryEntityStore();
    this.audit = deps.audit;
    this.investigations = deps.investigations;
  }

  async listEntities(filter: EntityFilter = {}): Promise<InvestigationEntityListV1> {
    if (filter.kind !== undefined && !isEntityKind(filter.kind)) {
      throw new Error("unknown entity kind");
    }
    if (filter.lifecycle !== undefined && !isEntityLifecycle(filter.lifecycle)) {
      throw new Error("unknown entity lifecycle");
    }
    const needle = filter.query?.trim().toLowerCase() ?? "";
    const rows = (await this.store.listEntities())
      .filter((row) => (filter.kind ? row.kind === filter.kind : true))
      .filter((row) => (filter.lifecycle ? row.lifecycle === filter.lifecycle : true))
      .filter((row) => (needle === "" ? true : row.label.toLowerCase().includes(needle)))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    return { schemaId: ENTITY_LIST_SCHEMA_ID, entities: rows.map(toEntityV1) };
  }

  async getEntity(id: string): Promise<InvestigationEntityV1 | null> {
    const row = await this.store.getEntity(id);
    return row ? toEntityV1(row) : null;
  }

  async createEntity(
    actor: Actor,
    input: EntityCreateInput,
    origin: string,
  ): Promise<InvestigationEntityV1> {
    if (!isEntityKind(input.kind)) throw new Error("unknown entity kind");
    const label = normalizeEntityLabel(input.label);
    const profile = normalizeEntityProfile(input.profile);
    const privacyClass = assertPrivacyClass(input.privacyClass);
    const now = new Date().toISOString();
    const row: EntityRow = {
      id: newEntityId(),
      kind: input.kind,
      label,
      profileSummary: profile?.summary ?? "",
      profileReference: profile?.reference ?? "",
      privacyClass,
      lifecycle: "active",
      createdAt: now,
      createdBy: actor.id,
      updatedAt: now,
    };
    await this.store.insertEntity(row);
    await this.audit?.append({
      identity: actor.id,
      action: "entity_create",
      target: row.id,
      origin,
      outcome: "success",
    });
    return toEntityV1(row);
  }

  /**
   * Reuse-first resolution. An existing active entity with the same kind and
   * label is returned rather than duplicated, which is what makes a label
   * reusable across investigations instead of retyped into a near-duplicate.
   */
  async resolveOrCreateEntity(
    actor: Actor,
    input: EntityCreateInput,
    origin: string,
  ): Promise<InvestigationEntityV1> {
    if (!isEntityKind(input.kind)) throw new Error("unknown entity kind");
    const label = normalizeEntityLabel(input.label);
    const existing = await this.store.findActiveByLabel(input.kind, label);
    if (existing) return toEntityV1(existing);
    try {
      return await this.createEntity(actor, { ...input, label }, origin);
    } catch (error) {
      if (!(error instanceof DuplicateEntityError)) throw error;
      const concurrent = await this.store.getEntity(error.existingId);
      if (concurrent) return toEntityV1(concurrent);
      throw error;
    }
  }

  async updateEntity(
    actor: Actor,
    id: string,
    patch: { label?: unknown; profile?: unknown; privacyClass?: string },
    origin: string,
  ): Promise<InvestigationEntityV1> {
    const existing = await this.store.getEntity(id);
    if (!existing) throw new EntityNotFoundError();
    const label =
      patch.label === undefined ? existing.label : normalizeEntityLabel(patch.label);
    const profile =
      patch.profile === undefined
        ? existing.profileSummary === "" && existing.profileReference === ""
          ? null
          : { summary: existing.profileSummary, reference: existing.profileReference }
        : normalizeEntityProfile(patch.profile);
    const privacyClass =
      patch.privacyClass === undefined ? existing.privacyClass : assertPrivacyClass(patch.privacyClass);
    await this.store.updateEntity(id, {
      label,
      profileSummary: profile?.summary ?? "",
      profileReference: profile?.reference ?? "",
      privacyClass,
      updatedAt: new Date().toISOString(),
    });
    await this.audit?.append({
      identity: actor.id,
      action: "entity_update",
      target: id,
      origin,
      outcome: "success",
    });
    const updated = await this.store.getEntity(id);
    if (!updated) throw new EntityNotFoundError();
    return toEntityV1(updated);
  }

  /**
   * Retiring stops an entity being chosen for new work. It never rewrites the
   * links that already name it: every existing involvement keeps the label and
   * kind it recorded, so older investigations still read as they were written.
   */
  async retireEntity(actor: Actor, id: string, origin: string): Promise<InvestigationEntityV1> {
    const existing = await this.store.getEntity(id);
    if (!existing) throw new EntityNotFoundError();
    await this.store.setEntityLifecycle(id, "retired", new Date().toISOString());
    await this.audit?.append({
      identity: actor.id,
      action: "entity_retire",
      target: id,
      origin,
      outcome: "success",
    });
    const updated = await this.store.getEntity(id);
    if (!updated) throw new EntityNotFoundError();
    return toEntityV1(updated);
  }

  private async requireVisibleInvestigation(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string; title: string }> {
    if (!this.investigations) throw new InvestigationNotVisibleError();
    const row = await this.investigations.getCase(caseId, actor, isAdmin);
    if (!row) throw new InvestigationNotVisibleError();
    return row;
  }

  async listInvolvements(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<InvestigationInvolvementListV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    const rows = await this.store.listInvolvements(caseId);
    const involvements = await this.projectAll(rows);
    return {
      schemaId: INVOLVEMENT_LIST_SCHEMA_ID,
      investigationId: caseId,
      involvements,
    };
  }

  /**
   * Entity-to-investigation index for the investigation list filter, scoped to
   * what this reader may already see. It carries identities and relationships
   * only: filtering by entity must never disclose an investigation the reader
   * could not otherwise open.
   */
  async involvementIndex(
    actor: Actor,
    isAdmin: boolean,
    visibleCaseIds: readonly string[],
  ): Promise<InvolvementIndexV1> {
    const allowed = new Set(visibleCaseIds);
    const rows = (await this.store.listAllInvolvements()).filter((row) => allowed.has(row.caseId));
    return {
      schemaId: INVOLVEMENT_INDEX_SCHEMA_ID,
      entries: rows.map((row) => ({
        investigationId: row.caseId,
        entityId: row.entityId,
        relationship: row.relationship,
        state: row.state,
      })),
    };
  }

  /**
   * Storage-backed collection-query projection for a membership-authorized
   * investigation set. It intentionally carries only the link identity and a
   * display label; profile and privacy metadata never enter the case query.
   */
  async collectionLinks(
    visibleCaseIds: readonly string[],
  ): Promise<Array<{ caseId: string; entityId: string; label: string }>> {
    const allowed = new Set(visibleCaseIds);
    const rows = (await this.store.listAllInvolvements()).filter((row) => allowed.has(row.caseId));
    const entities = new Map<string, EntityRow | null>();
    const links: Array<{ caseId: string; entityId: string; label: string }> = [];
    for (const row of rows) {
      if (!entities.has(row.entityId)) {
        entities.set(row.entityId, await this.store.getEntity(row.entityId));
      }
      links.push({
        caseId: row.caseId,
        entityId: row.entityId,
        label: entities.get(row.entityId)?.label ?? row.recordedLabel,
      });
    }
    return links;
  }

  async recordInvolvement(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    input: InvolvementInput,
    origin: string,
  ): Promise<InvestigationInvolvementV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    if (!isInvolvementRelationship(input.relationship)) {
      throw new Error("unknown involvement relationship");
    }
    const entity = await this.store.getEntity(input.entityId);
    if (!entity) throw new EntityNotFoundError();
    // A retired label stays readable in history but cannot start new work.
    if (entity.lifecycle === "retired") throw new RetiredEntityError();
    const note = normalizeInvolvementNote(input.note);
    const occurrence = normalizeOccurredAt(input, { path: "$" });
    const row: InvolvementRow = {
      id: newEntityId(),
      caseId,
      entityId: entity.id,
      relationship: input.relationship,
      state: "active",
      note,
      recordedLabel: entity.label,
      recordedKind: entity.kind,
      occurredAt: occurrence.occurredAt,
      occurredAtPrecision: occurrence.occurredAtPrecision,
      occurredAtZone: occurrence.occurredAtZone,
      recordedAt: new Date().toISOString(),
      recordedBy: actor.id,
      recordedByUsername: actor.username,
      releasedAt: null,
    };
    await this.store.insertInvolvement(row);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "entity_involved",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: {
        entityId: entity.id,
        relationship: row.relationship,
        recordedLabel: row.recordedLabel,
        recordedKind: row.recordedKind,
      },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "entity_involve",
      target: `${caseId}:${entity.id}`,
      origin,
      outcome: "success",
    });
    return toInvolvementV1(row, entity);
  }

  /**
   * Ends an involvement. The row stays: a reader a year from now still needs
   * to see that this entity was once part of the investigation, and when that
   * stopped being true.
   */
  async releaseInvolvement(
    caseId: string,
    involvementId: string,
    actor: Actor,
    isAdmin: boolean,
    origin: string,
  ): Promise<InvestigationInvolvementV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    const row = await this.store.getInvolvement(involvementId);
    if (!row || row.caseId !== caseId) throw new EntityNotFoundError();
    if (row.state === "released") {
      return toInvolvementV1(row, await this.store.getEntity(row.entityId));
    }
    const releasedAt = new Date().toISOString();
    await this.store.releaseInvolvement(involvementId, releasedAt);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "entity_released",
      actor,
      targetId: involvementId,
      clientTime: null,
      payload: { entityId: row.entityId, recordedLabel: row.recordedLabel },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "entity_release",
      target: `${caseId}:${row.entityId}`,
      origin,
      outcome: "success",
    });
    const updated = await this.store.getInvolvement(involvementId);
    if (!updated) throw new EntityNotFoundError();
    return toInvolvementV1(updated, await this.store.getEntity(row.entityId));
  }

  /** Involvement rows for a case with no authorization check, for export projection. */
  async involvementsForExport(caseId: string): Promise<InvestigationInvolvementV1[]> {
    return this.projectAll(await this.store.listInvolvements(caseId));
  }

  /**
   * Which entity labels the registry has marked safe to leave the tool. The
   * export projection reads this rather than deciding for itself, so one
   * registry decision governs every export.
   */
  async entityPrivacyMap(): Promise<ReadonlyMap<string, PrivacyClass>> {
    const rows = await this.store.listEntities();
    return new Map(rows.map((row) => [row.id, row.privacyClass]));
  }

  private async projectAll(rows: InvolvementRow[]): Promise<InvestigationInvolvementV1[]> {
    const entities = new Map<string, EntityRow | null>();
    const out: InvestigationInvolvementV1[] = [];
    for (const row of rows) {
      if (!entities.has(row.entityId)) {
        entities.set(row.entityId, await this.store.getEntity(row.entityId));
      }
      out.push(toInvolvementV1(row, entities.get(row.entityId) ?? null));
    }
    return out;
  }
}

export {
  DuplicateEntityError,
  DuplicateInvolvementError,
  MemoryEntityStore,
  PgEntityStore,
} from "./store.js";
export type { EntityRow, EntityStore, InvolvementRow } from "./store.js";
export type { EntityKind, InvolvementRelationship };
