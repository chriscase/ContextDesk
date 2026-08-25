import {
  RESOLUTION_LIST_SCHEMA_ID,
  assertResolutionBasis,
  isResolutionBasis,
  normalizeOccurredAt,
  normalizeRationale,
  normalizeUnknowns,
  statusRequiresResolution,
  type CaseStatus,
  type InvestigationProvenanceClassV1,
  type InvestigationResolutionListV1,
  type InvestigationResolutionV1,
  type ResolutionBasis,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import {
  MemoryResolutionStore,
  ResolutionRevisionConflictError,
  newResolutionId,
  toResolutionV1,
  type ResolutionRow,
  type ResolutionStore,
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
  ): Promise<{ id: string; title: string; status?: string } | null>;
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

export class InvestigationNotVisibleError extends Error {
  constructor() {
    super("investigation not found");
    this.name = "InvestigationNotVisibleError";
  }
}

export interface ResolutionInput {
  basis: string;
  rationale: unknown;
  unknowns?: unknown;
  provenance?: string;
  experimentDecisionId?: string | null;
  exceptionReason?: string | null;
  citedArtifactIds?: unknown;
  citedContributionIds?: unknown;
  occurredAt?: unknown;
  occurredAtPrecision?: unknown;
  occurredAtZone?: unknown;
  /**
   * The revision the author believes is active, so two people resolving the
   * same investigation at once conflict loudly instead of one silently
   * overwriting the other's reasoning. 0 means "I believe there is none".
   */
  expectedRevision?: number;
}

function idList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${label} must contain identifiers`);
    }
    return item;
  });
}

/**
 * Resolution records, and the guard that keeps `resolved` from being a bare
 * status flip.
 *
 * The rule this module exists to enforce: an investigation reaches `resolved`
 * only with an active resolution record behind it. Reaching it by human
 * reasoning alone is fully supported and is not a lesser path — what is not
 * supported is reaching it silently, with nothing recorded about who decided,
 * why, or what stayed unknown.
 *
 * Leaving `resolved` supersedes the active record rather than deleting it. The
 * earlier reasoning stays readable, and re-resolving later needs its own fresh
 * record instead of quietly reusing a conclusion that was already withdrawn.
 */
export class ResolutionService {
  private readonly store: ResolutionStore;
  private readonly audit: AuditStore | undefined;
  private investigations: InvestigationGateway | undefined;

  constructor(deps: {
    store?: ResolutionStore;
    audit?: AuditStore;
    investigations?: InvestigationGateway;
  } = {}) {
    this.store = deps.store ?? new MemoryResolutionStore();
    this.audit = deps.audit;
    this.investigations = deps.investigations;
  }

  /**
   * Completes the cycle at wiring time. The case service takes this guard in
   * its constructor, so the gateway back to it can only be supplied
   * afterwards. Set once; a second call is a wiring mistake, not a rebind.
   */
  bindInvestigations(gateway: InvestigationGateway): void {
    if (this.investigations) throw new Error("investigation gateway is already bound");
    this.investigations = gateway;
  }

  async list(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<InvestigationResolutionListV1> {
    await this.requireVisible(caseId, actor, isAdmin);
    const rows = await this.store.listByCase(caseId);
    return {
      schemaId: RESOLUTION_LIST_SCHEMA_ID,
      investigationId: caseId,
      resolutions: rows.map(toResolutionV1),
    };
  }

  async active(caseId: string): Promise<InvestigationResolutionV1 | null> {
    const row = await this.store.activeForCase(caseId);
    return row ? toResolutionV1(row) : null;
  }

  /**
   * Records a resolution. Called on its own (record first, then resolve) or
   * from inside the status transition, so an operator can do it in one step
   * without the two ever drifting apart.
   */
  async record(
    caseId: string,
    actor: Actor,
    input: ResolutionInput,
    origin: string,
  ): Promise<InvestigationResolutionV1> {
    if (!isResolutionBasis(input.basis)) throw new Error("unknown resolution basis");
    const basis: ResolutionBasis = input.basis;
    const provenance = (input.provenance ?? "human") as InvestigationProvenanceClassV1;
    const rationale = normalizeRationale(input.rationale);
    const unknowns = normalizeUnknowns(input.unknowns);
    const experimentDecisionId = input.experimentDecisionId ?? null;
    const exceptionReason = input.exceptionReason ?? null;
    assertResolutionBasis({ basis, experimentDecisionId, exceptionReason, provenance });
    const citedArtifactIds = idList(input.citedArtifactIds, "citedArtifactIds");
    const citedContributionIds = idList(input.citedContributionIds, "citedContributionIds");
    const occurrence = normalizeOccurredAt(input, { path: "$" });

    const active = await this.store.activeForCase(caseId);
    const currentRevision = active?.revision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new ResolutionRevisionConflictError(currentRevision);
    }
    const now = new Date().toISOString();
    if (active) await this.store.supersede(active.id, now);

    const row: ResolutionRow = {
      id: newResolutionId(),
      caseId,
      revision: currentRevision + 1,
      predecessorRevision: currentRevision === 0 ? null : currentRevision,
      basis,
      provenance,
      status: "resolved",
      rationale,
      unknowns,
      experimentDecisionId,
      exceptionReason,
      citedArtifactIds,
      citedContributionIds,
      occurredAt: occurrence.occurredAt,
      occurredAtPrecision: occurrence.occurredAtPrecision,
      occurredAtZone: occurrence.occurredAtZone,
      recordedAt: now,
      recordedBy: actor.id,
      recordedByUsername: actor.username,
      supersededAt: null,
    };
    await this.store.insert(row);
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "investigation_resolution_recorded",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: { basis: row.basis, revision: row.revision, unknowns: row.unknowns.length },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "investigation_resolution_record",
      target: `${caseId}:${row.revision}`,
      origin,
      outcome: "success",
    });
    return toResolutionV1(row);
  }

  async recordForCase(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    input: ResolutionInput,
    origin: string,
  ): Promise<InvestigationResolutionV1> {
    await this.requireVisible(caseId, actor, isAdmin);
    return this.record(caseId, actor, input, origin);
  }

  /**
   * The status guard. Wired into the case status transition so the rule cannot
   * be bypassed by calling the status route directly — UI visibility is never
   * authorization, and neither is UI sequencing.
   */
  async authorizeStatus(input: {
    caseId: string;
    status: CaseStatus;
    previousStatus: CaseStatus;
    actor: Actor;
    origin: string;
    resolution?: ResolutionInput;
    expectedResolutionRevision?: number;
  }): Promise<void> {
    if (!statusRequiresResolution(input.status)) {
      // Leaving a resolved state withdraws the reasoning that authorised it.
      if (statusRequiresResolution(input.previousStatus)) {
        const active = await this.store.activeForCase(input.caseId);
        if (active) {
          await this.store.supersede(active.id, new Date().toISOString());
          await this.audit?.append({
            identity: input.actor.id,
            action: "investigation_resolution_supersede",
            target: `${input.caseId}:${active.revision}`,
            origin: input.origin,
            outcome: "success",
          });
        }
      }
      return;
    }
    if (input.resolution) {
      const supplied: ResolutionInput = { ...input.resolution };
      if (
        supplied.expectedRevision === undefined &&
        input.expectedResolutionRevision !== undefined
      ) {
        supplied.expectedRevision = input.expectedResolutionRevision;
      }
      await this.record(input.caseId, input.actor, supplied, input.origin);
      return;
    }
    const active = await this.store.activeForCase(input.caseId);
    if (!active) {
      await this.audit?.append({
        identity: input.actor.id,
        action: "case_status",
        target: `${input.caseId}:${input.status}`,
        origin: input.origin,
        outcome: "denied",
      });
      throw new ResolutionRequiredError(input.status);
    }
    if (
      input.expectedResolutionRevision !== undefined &&
      input.expectedResolutionRevision !== active.revision
    ) {
      throw new ResolutionRevisionConflictError(active.revision);
    }
  }

  private async requireVisible(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string; title: string }> {
    if (!this.investigations) throw new InvestigationNotVisibleError();
    const row = await this.investigations.getCase(caseId, actor, isAdmin);
    if (!row) throw new InvestigationNotVisibleError();
    return row;
  }
}

/**
 * Raised when a status that claims the question was answered is requested with
 * nothing recorded to back it. Carries the status so the UI can open the right
 * form instead of showing a bare refusal.
 */
export class ResolutionRequiredError extends Error {
  constructor(readonly status: CaseStatus) {
    super("resolution_required");
    this.name = "ResolutionRequiredError";
  }
}

export {
  MemoryResolutionStore,
  PgResolutionStore,
  ResolutionRevisionConflictError,
  toResolutionV1,
} from "./store.js";
export type { ResolutionRow, ResolutionStore } from "./store.js";
