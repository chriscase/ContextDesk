import {
  INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
  INVESTIGATION_REFERENCE_SCHEMA_ID,
  isReferenceResourceKind,
  normalizeOccurredAt,
  normalizeReferenceNote,
  referenceLocator,
  wholeInvestigationReferenceTarget,
  type InvestigationReferenceListV1,
  type InvestigationReferenceV1,
  type InvestigationResourceKindV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import {
  DuplicateReferenceError,
  MemoryReferenceStore,
  newReferenceId,
  type ReferenceRow,
  type ReferenceStore,
} from "./store.js";

export interface Actor {
  id: string;
  username: string;
}

/** The narrow view of the investigation domain this module needs. */
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

export class ReferenceNotFoundError extends Error {
  constructor() {
    super("reference not found");
    this.name = "ReferenceNotFoundError";
  }
}

export class CitingInvestigationNotVisibleError extends Error {
  constructor() {
    super("investigation not found");
    this.name = "CitingInvestigationNotVisibleError";
  }
}

/**
 * The author cannot read the investigation they are trying to cite. Reported
 * separately from a missing investigation so the UI can say "you cannot cite
 * this" instead of "this does not exist" — the author picked it from a list of
 * things they *can* see, so a bare 404 would read as a bug.
 */
export class CitedInvestigationNotAuthorizedError extends Error {
  constructor() {
    super("cited investigation is not readable by this actor");
    this.name = "CitedInvestigationNotAuthorizedError";
  }
}

export class SelfReferenceError extends Error {
  constructor() {
    super("an investigation cannot cite itself");
    this.name = "SelfReferenceError";
  }
}

export interface ReferenceInput {
  toInvestigationId: string;
  resourceKind?: string;
  resourceId?: string;
  note?: unknown;
  occurredAt?: unknown;
  occurredAtPrecision?: unknown;
  occurredAtZone?: unknown;
}

/**
 * Authorized cross-investigation references.
 *
 * A reference is a pointer and a reason. It copies nothing out of the cited
 * investigation, writes nothing into it, and is never promoted into evidence
 * or a contribution — citing older work must not silently turn that work into
 * support for a hypothesis in this one.
 *
 * Authorization happens twice, and the second time is the one that matters:
 * the author must be able to read the cited investigation when the citation is
 * written, and *every reader* is re-checked when the citation is read. A
 * reader who cannot open the cited case sees that the citation exists and
 * where it points, and does not see its title.
 */
export class ReferenceService {
  private readonly store: ReferenceStore;
  private readonly audit: AuditStore | undefined;
  private readonly investigations: InvestigationGateway | undefined;

  constructor(deps: {
    store?: ReferenceStore;
    audit?: AuditStore;
    investigations?: InvestigationGateway;
  } = {}) {
    this.store = deps.store ?? new MemoryReferenceStore();
    this.audit = deps.audit;
    this.investigations = deps.investigations;
  }

  async list(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<InvestigationReferenceListV1> {
    await this.requireCiting(caseId, actor, isAdmin);
    const [outboundRows, inboundRows] = await Promise.all([
      this.store.listOutbound(caseId),
      this.store.listInbound(caseId),
    ]);
    const outbound = await this.projectAll(outboundRows, "to", actor, isAdmin);
    const inbound = await this.projectAll(inboundRows, "from", actor, isAdmin);
    return {
      schemaId: INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
      investigationId: caseId,
      outbound,
      inbound,
    };
  }

  async create(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    input: ReferenceInput,
    origin: string,
  ): Promise<InvestigationReferenceV1> {
    await this.requireCiting(caseId, actor, isAdmin);
    if (input.toInvestigationId === caseId) throw new SelfReferenceError();

    // The cited investigation must be readable by this author right now.
    // Nothing about the citing investigation's membership grants it.
    const cited = this.investigations
      ? await this.investigations.getCase(input.toInvestigationId, actor, isAdmin)
      : null;
    if (!cited) {
      await this.audit?.append({
        identity: actor.id,
        action: "investigation_reference_create",
        target: `${caseId}:${input.toInvestigationId}`,
        origin,
        outcome: "denied",
      });
      throw new CitedInvestigationNotAuthorizedError();
    }

    const target =
      input.resourceKind === undefined || input.resourceKind === "investigation"
        ? wholeInvestigationReferenceTarget(cited.id)
        : {
            resourceKind: input.resourceKind as InvestigationResourceKindV1,
            resourceId: input.resourceId ?? "",
          };
    if (!isReferenceResourceKind(target.resourceKind)) {
      throw new Error("unknown reference resource kind");
    }
    if (target.resourceId.trim() === "") {
      throw new Error("a resource reference must name the resource");
    }
    // Throws when the target cannot address a real destination, so a citation
    // can never be stored pointing at a URL the app would not resolve.
    const locator = referenceLocator(cited.id, target.resourceKind, target.resourceId);
    const occurrence = normalizeOccurredAt(input, { path: "$" });

    const row: ReferenceRow = {
      id: newReferenceId(),
      fromCaseId: caseId,
      toCaseId: cited.id,
      resourceKind: target.resourceKind,
      resourceId: target.resourceId,
      locator,
      note: normalizeReferenceNote(input.note),
      recordedTitle: cited.title,
      state: "active",
      occurredAt: occurrence.occurredAt,
      occurredAtPrecision: occurrence.occurredAtPrecision,
      occurredAtZone: occurrence.occurredAtZone,
      recordedAt: new Date().toISOString(),
      recordedBy: actor.id,
      recordedByUsername: actor.username,
      withdrawnAt: null,
    };
    await this.store.insert(row);
    // Recorded on the citing investigation only. The cited investigation's own
    // record is left exactly as it was.
    await this.investigations?.appendDomainTimeline(caseId, {
      kind: "investigation_referenced",
      actor,
      targetId: row.id,
      clientTime: null,
      payload: {
        toInvestigationId: row.toCaseId,
        resourceKind: row.resourceKind,
        recordedTitle: row.recordedTitle,
      },
    });
    await this.audit?.append({
      identity: actor.id,
      action: "investigation_reference_create",
      target: `${caseId}:${row.toCaseId}`,
      origin,
      outcome: "success",
    });
    return this.project(row, "to", cited);
  }

  async withdraw(
    caseId: string,
    referenceId: string,
    actor: Actor,
    isAdmin: boolean,
    origin: string,
  ): Promise<InvestigationReferenceV1> {
    await this.requireCiting(caseId, actor, isAdmin);
    const row = await this.store.get(referenceId);
    if (!row || row.fromCaseId !== caseId) throw new ReferenceNotFoundError();
    if (row.state === "active") {
      await this.store.withdraw(referenceId, new Date().toISOString());
      await this.investigations?.appendDomainTimeline(caseId, {
        kind: "investigation_reference_withdrawn",
        actor,
        targetId: referenceId,
        clientTime: null,
        payload: { toInvestigationId: row.toCaseId },
      });
      await this.audit?.append({
        identity: actor.id,
        action: "investigation_reference_withdraw",
        target: `${caseId}:${row.toCaseId}`,
        origin,
        outcome: "success",
      });
    }
    const updated = await this.store.get(referenceId);
    if (!updated) throw new ReferenceNotFoundError();
    return this.projectOne(updated, "to", actor, isAdmin);
  }

  /** Outbound rows for a case with no authorization check, for export projection. */
  async outboundForExport(caseId: string): Promise<ReferenceRow[]> {
    return this.store.listOutbound(caseId);
  }

  private async requireCiting(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string; title: string }> {
    if (!this.investigations) throw new CitingInvestigationNotVisibleError();
    const row = await this.investigations.getCase(caseId, actor, isAdmin);
    if (!row) throw new CitingInvestigationNotVisibleError();
    return row;
  }

  private async projectAll(
    rows: ReferenceRow[],
    side: "to" | "from",
    actor: Actor,
    isAdmin: boolean,
  ): Promise<InvestigationReferenceV1[]> {
    const resolved = new Map<string, { id: string; title: string } | null>();
    const out: InvestigationReferenceV1[] = [];
    for (const row of rows) {
      const otherId = side === "to" ? row.toCaseId : row.fromCaseId;
      if (!resolved.has(otherId)) {
        resolved.set(
          otherId,
          this.investigations
            ? await this.investigations.getCase(otherId, actor, isAdmin)
            : null,
        );
      }
      out.push(this.project(row, side, resolved.get(otherId) ?? null));
    }
    return out;
  }

  private async projectOne(
    row: ReferenceRow,
    side: "to" | "from",
    actor: Actor,
    isAdmin: boolean,
  ): Promise<InvestigationReferenceV1> {
    const otherId = side === "to" ? row.toCaseId : row.fromCaseId;
    const other = this.investigations
      ? await this.investigations.getCase(otherId, actor, isAdmin)
      : null;
    return this.project(row, side, other);
  }

  /**
   * Fail closed: an unresolved counterpart is `restricted` with no live title,
   * not an optimistic guess.
   *
   * `recordedTitle` always travels, on both sides. It is what the *citing*
   * investigation wrote down at citation time, so on an outbound row it is
   * this investigation's own record of what it cited, and on an inbound row it
   * is what this investigation was called when someone else cited it. Neither
   * discloses the counterpart's current state; `currentTitle` does, and that
   * is the field authorization gates.
   */
  private project(
    row: ReferenceRow,
    _side: "to" | "from",
    other: { id: string; title: string } | null,
  ): InvestigationReferenceV1 {
    const visible = other !== null;
    return {
      schemaId: INVESTIGATION_REFERENCE_SCHEMA_ID,
      id: row.id,
      fromInvestigationId: row.fromCaseId,
      toInvestigationId: row.toCaseId,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      locator: row.locator,
      note: row.note,
      recordedTitle: row.recordedTitle,
      currentTitle: visible ? (other?.title ?? null) : null,
      visibility: visible ? "resolved" : "restricted",
      state: row.state,
      occurredAt: row.occurredAt,
      occurredAtPrecision: row.occurredAtPrecision,
      occurredAtZone: row.occurredAtZone,
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy,
      recordedByUsername: row.recordedByUsername,
      withdrawnAt: row.withdrawnAt,
    };
  }
}

export { DuplicateReferenceError, MemoryReferenceStore, PgReferenceStore } from "./store.js";
export type { ReferenceRow, ReferenceStore } from "./store.js";
