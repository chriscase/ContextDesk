import {
  SOFTWARE_IMPACT_LIST_SCHEMA_ID,
  SOFTWARE_IMPACT_ORDERING,
  SOFTWARE_IMPACT_SUGGESTIONS_SCHEMA_ID,
  isSoftwareImpactField,
  isSoftwareImpactStatus,
  normalizeSoftwareImpactIdentity,
  normalizeSoftwareImpactNote,
  type SoftwareImpactField,
  type SoftwareImpactIdentityV1,
  type SoftwareImpactListV1,
  type SoftwareImpactStatus,
  type SoftwareImpactSuggestionsV1,
  type SoftwareImpactV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import {
  DuplicateSoftwareImpactError,
  InvestigationNotVisibleError,
  MemorySoftwareImpactStore,
  SoftwareImpactNotFoundError,
  SoftwareImpactReleasedError,
  newSoftwareImpactId,
  toSoftwareImpactV1,
  type SoftwareImpactRow,
  type SoftwareImpactStore,
} from "./store.js";

export interface Actor {
  id: string;
  username: string;
}

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

export interface SoftwareImpactCreateInput extends Partial<SoftwareImpactIdentityV1> {
  status: string;
  note?: unknown;
}

function recordedOrder(left: SoftwareImpactRow, right: SoftwareImpactRow): number {
  // Equal timestamps keep store insertion order (Array.sort is stable here).
  // Sorting by id would invent an order that is not recording order.
  return left.recordedAt.localeCompare(right.recordedAt);
}

export class SoftwareImpactService {
  private readonly store: SoftwareImpactStore;
  private readonly audit: AuditStore | undefined;
  private readonly investigations: InvestigationGateway | undefined;

  constructor(deps: {
    store?: SoftwareImpactStore;
    audit?: AuditStore;
    investigations?: InvestigationGateway;
  } = {}) {
    this.store = deps.store ?? new MemorySoftwareImpactStore();
    this.audit = deps.audit;
    this.investigations = deps.investigations;
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

  async list(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<SoftwareImpactListV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    const records = (await this.store.list(caseId))
      .sort(recordedOrder)
      .map(toSoftwareImpactV1);
    return {
      schemaId: SOFTWARE_IMPACT_LIST_SCHEMA_ID,
      investigationId: caseId,
      ordering: SOFTWARE_IMPACT_ORDERING,
      records,
    };
  }

  async suggestions(
    field: string,
    _actor: Actor,
    _isAdmin: boolean,
    visibleCaseIds: readonly string[],
  ): Promise<SoftwareImpactSuggestionsV1> {
    if (!isSoftwareImpactField(field)) throw new Error("unknown software impact field");
    const allowed = new Set(visibleCaseIds);
    const values = new Set<string>();
    for (const row of await this.store.listAll()) {
      if (!allowed.has(row.caseId)) continue;
      const value = row[field as SoftwareImpactField];
      if (value) values.add(value);
    }
    return {
      schemaId: SOFTWARE_IMPACT_SUGGESTIONS_SCHEMA_ID,
      field,
      values: [...values].sort((left, right) => left.localeCompare(right)),
    };
  }

  async record(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    input: SoftwareImpactCreateInput,
    origin: string,
  ): Promise<SoftwareImpactV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    if (!isSoftwareImpactStatus(input.status)) throw new Error("unknown software impact status");
    const identity = normalizeSoftwareImpactIdentity(input);
    const note = normalizeSoftwareImpactNote(input.note);
    const now = new Date().toISOString();
    const row: SoftwareImpactRow = {
      id: newSoftwareImpactId(),
      caseId,
      ...identity,
      status: input.status,
      note,
      state: "active",
      recordedAt: now,
      recordedBy: actor.id,
      recordedByUsername: actor.username,
      updatedAt: now,
      releasedAt: null,
    };
    await this.store.insert(row);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "software_impact_recorded",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: {
        status: row.status,
        productName: row.productName,
        version: row.version,
        build: row.build,
        component: row.component,
        environment: row.environment,
      },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "software_impact_record",
      target: `${caseId}:${row.id}`,
      origin,
      outcome: "success",
    });
    return toSoftwareImpactV1(row);
  }

  async setStatus(
    caseId: string,
    impactId: string,
    actor: Actor,
    isAdmin: boolean,
    status: string,
    note: unknown,
    origin: string,
  ): Promise<SoftwareImpactV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    if (!isSoftwareImpactStatus(status)) throw new Error("unknown software impact status");
    const existing = await this.store.get(impactId);
    if (!existing || existing.caseId !== caseId) throw new SoftwareImpactNotFoundError();
    const nextNote = note === undefined ? existing.note : normalizeSoftwareImpactNote(note);
    const now = new Date().toISOString();
    await this.store.updateStatus(impactId, status, nextNote, now);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "software_impact_updated",
      actor,
      targetId: impactId,
      clientTime: null,
      payload: { previousStatus: existing.status, status },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "software_impact_status",
      target: `${caseId}:${impactId}`,
      origin,
      outcome: "success",
    });
    const updated = await this.store.get(impactId);
    if (!updated) throw new SoftwareImpactNotFoundError();
    return toSoftwareImpactV1(updated);
  }

  async release(
    caseId: string,
    impactId: string,
    actor: Actor,
    isAdmin: boolean,
    origin: string,
  ): Promise<SoftwareImpactV1> {
    await this.requireVisibleInvestigation(caseId, actor, isAdmin);
    const existing = await this.store.get(impactId);
    if (!existing || existing.caseId !== caseId) throw new SoftwareImpactNotFoundError();
    const now = new Date().toISOString();
    await this.store.release(impactId, now);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "software_impact_released",
      actor,
      targetId: impactId,
      clientTime: null,
      payload: { status: existing.status },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "software_impact_release",
      target: `${caseId}:${impactId}`,
      origin,
      outcome: "success",
    });
    const updated = await this.store.get(impactId);
    if (!updated) throw new SoftwareImpactNotFoundError();
    return toSoftwareImpactV1(updated);
  }
}

export {
  DuplicateSoftwareImpactError,
  InvestigationNotVisibleError,
  MemorySoftwareImpactStore,
  SoftwareImpactNotFoundError,
  SoftwareImpactReleasedError,
};
export type { SoftwareImpactRow, SoftwareImpactStore };
