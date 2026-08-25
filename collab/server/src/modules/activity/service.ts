/**
 * Authorized investigation-activity projection and locator resolution.
 * Timeline remains the source of truth; this module does not persist a feed.
 */
import {
  ContractViolation,
  INVESTIGATION_ACTIVITY_DEFAULT_LIMIT,
  INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_CAP,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
  INVESTIGATION_STAGES,
  activityItemIsAfterCursor,
  canonicalInvestigationActivityBytes,
  compareInvestigationActivityItems,
  formatInvestigationActivityCursor,
  investigationActivityFilterFingerprint,
  parseCompactInvestigationLocator,
  parseInvestigationActivityCursor,
  parseInvestigationActivityPage,
  parseInvestigationLocatorInput,
  parseInvestigationResourceResolve,
  safeInvestigationTitle,
  type InvestigationActivityErrorV1,
  type InvestigationActivityFilterV1,
  type InvestigationActivityKindV1,
  type InvestigationActivityPageV1,
  type InvestigationResourceLocatorV1,
  type InvestigationResourceResolveV1,
  type InvestigationStageV1,
} from "@cd-collab/contracts";
import type { Actor, CaseService, TimelineRow } from "../cases/index.js";
import {
  INVESTIGATION_ACTIVITY_SOURCE_WINDOW,
  projectTimelineSource,
  resourceLabelForKind,
  type ProjectedInvestigationActivity,
} from "./project.js";

export class InvestigationActivityError extends Error {
  constructor(readonly code: InvestigationActivityErrorV1["error"]) {
    super(code);
    this.name = "InvestigationActivityError";
  }

  toJSON(): InvestigationActivityErrorV1 {
    return { schemaId: INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID, error: this.code };
  }
}

export function investigationActivityErrorBody(
  error: InvestigationActivityErrorV1["error"],
): InvestigationActivityErrorV1 {
  return { schemaId: INVESTIGATION_ACTIVITY_ERROR_SCHEMA_ID, error };
}

export interface InvestigationActivityListInput {
  actor: Actor;
  isAdmin: boolean;
  caseId?: string;
  limit?: number;
  cursor?: string;
  filter?: InvestigationActivityFilterV1;
}

export interface InvestigationActivityServiceDeps {
  cases: CaseService;
  installationId: string;
}

const ACTIVITY_KINDS = new Set<string>([
  "investigation_created",
  "investigation_updated",
  "evidence_added",
  "evidence_reviewed",
  "evidence_frozen",
  "evidence_omitted",
  "evidence_privacy_classified",
  "workstream_launched",
  "workstream_completed",
  "workstream_partially_completed",
  "workstream_canceled",
  "workstream_failed",
  "workstream_rerun",
  "comment_added",
  "observation_recorded",
  "hypothesis_recorded",
  "hypothesis_updated",
  "action_recorded",
  "assignment_recorded",
  "mention_recorded",
  "handoff_recorded",
  "comparison_disagreement",
  "comparison_unknown",
  "decision_proposed",
  "decision_revised",
  "decision_accepted",
  "decision_superseded",
  "import_recorded",
  "export_recorded",
  "restore_recorded",
]);

function parseLimit(requested: number | undefined): number {
  const parsed = Math.trunc(requested ?? INVESTIGATION_ACTIVITY_DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvestigationActivityError("invalid_filter");
  }
  return Math.min(INVESTIGATION_ACTIVITY_PAGE_CAP, parsed);
}

export function parseInvestigationActivityQueryFilter(
  query: Record<string, unknown>,
): InvestigationActivityFilterV1 {
  const allowed = new Set([
    "limit",
    "cursor",
    "investigationId",
    "actorId",
    "activityKind",
    "stage",
    "workstreamId",
    "from",
    "to",
    "assignedToMe",
    "locator",
  ]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new InvestigationActivityError("invalid_filter");
  }
  const filter: InvestigationActivityFilterV1 = {};
  if (typeof query.investigationId === "string") filter.investigationId = query.investigationId;
  else if (query.investigationId !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.actorId === "string" && query.actorId.length >= 1 && query.actorId.length <= 128) {
    filter.actorId = query.actorId;
  } else if (query.actorId !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.activityKind === "string" && ACTIVITY_KINDS.has(query.activityKind)) {
    filter.activityKind = query.activityKind as InvestigationActivityKindV1;
  } else if (query.activityKind !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.stage === "string" && (INVESTIGATION_STAGES as readonly string[]).includes(query.stage)) {
    filter.stage = query.stage as InvestigationStageV1;
  } else if (query.stage !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.workstreamId === "string") filter.workstreamId = query.workstreamId;
  else if (query.workstreamId !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.from === "string") filter.from = query.from;
  else if (query.from !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (typeof query.to === "string") filter.to = query.to;
  else if (query.to !== undefined) throw new InvestigationActivityError("invalid_filter");
  if (query.assignedToMe !== undefined) {
    if (query.assignedToMe !== "true" && query.assignedToMe !== "false" && typeof query.assignedToMe !== "boolean") {
      throw new InvestigationActivityError("invalid_filter");
    }
    filter.assignedToMe = query.assignedToMe === true || query.assignedToMe === "true";
  }
  return filter;
}

function matchesFilter(
  projected: ProjectedInvestigationActivity,
  filter: InvestigationActivityFilterV1,
  viewerId: string,
): boolean {
  if (filter.investigationId && projected.item.investigationId !== filter.investigationId) return false;
  if (filter.actorId && projected.item.actorId !== filter.actorId) return false;
  if (filter.activityKind && projected.item.activityKind !== filter.activityKind) return false;
  if (filter.stage && projected.stage !== filter.stage) return false;
  if (filter.workstreamId && projected.workstreamId !== filter.workstreamId) return false;
  if (filter.from && projected.item.occurredAt < filter.from) return false;
  if (filter.to && projected.item.occurredAt > filter.to) return false;
  if (filter.assignedToMe && !projected.assignedActorIds.includes(viewerId)) return false;
  return true;
}

export class InvestigationActivityService {
  constructor(private readonly deps: InvestigationActivityServiceDeps) {}

  async listPage(input: InvestigationActivityListInput): Promise<InvestigationActivityPageV1> {
    const limit = parseLimit(input.limit);
    const filter: InvestigationActivityFilterV1 = {
      ...(input.filter ?? {}),
      ...(input.caseId ? { investigationId: input.caseId } : {}),
    };
    if (input.caseId && filter.investigationId && filter.investigationId !== input.caseId) {
      throw new InvestigationActivityError("invalid_filter");
    }
    const fingerprint = investigationActivityFilterFingerprint(filter);
    let cursor = null as ReturnType<typeof parseInvestigationActivityCursor> | null;
    if (input.cursor !== undefined && input.cursor !== "") {
      try {
        cursor = parseInvestigationActivityCursor(input.cursor);
      } catch {
        throw new InvestigationActivityError("malformed_cursor");
      }
      if (cursor.filterFingerprint !== fingerprint) {
        throw new InvestigationActivityError("stale_cursor");
      }
    }
    const sources = await this.deps.cases.listAuthorizedTimelineSources(input.actor, input.isAdmin, {
      ...(input.caseId ? { caseId: input.caseId } : {}),
      limit: input.caseId ? Number.MAX_SAFE_INTEGER : INVESTIGATION_ACTIVITY_SOURCE_WINDOW,
    });
    if (input.caseId && sources.length === 0) {
      const visible = await this.deps.cases.getCase(input.caseId, input.actor, input.isAdmin);
      if (!visible) throw new InvestigationActivityError("not_found");
    }
    const projected = sources
      .flatMap((source) => {
        const item = projectTimelineSource({ installationId: this.deps.installationId, source });
        return item ? [item] : [];
      })
      .filter((item) => matchesFilter(item, filter, input.actor.id))
      .sort((left, right) => compareInvestigationActivityItems(left.item, right.item));
    if (cursor) {
      const found = projected.some((row) =>
        row.item.activityId === cursor.activityId
        && row.item.occurredAt === cursor.occurredAt
        && row.item.investigationId === cursor.investigationId
        && row.item.orderTieBreak === cursor.seq
      );
      if (!found) throw new InvestigationActivityError("stale_cursor");
    }
    const following = cursor
      ? projected.filter((row) => activityItemIsAfterCursor(row.item, cursor))
      : projected;
    const pageItems = following.slice(0, limit).map((row) => row.item);
    const last = pageItems[pageItems.length - 1];
    const nextCursor = last && following.length > limit
      ? formatInvestigationActivityCursor({
          v: 1,
          occurredAt: last.occurredAt,
          investigationId: last.investigationId,
          seq: last.orderTieBreak,
          activityId: last.activityId,
          filterFingerprint: fingerprint,
        })
      : null;
    return parseInvestigationActivityPage({
      schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
      items: pageItems,
      nextCursor,
      notices: [...INVESTIGATION_ACTIVITY_NOTICES],
    });
  }

  canonicalPageBytes(page: InvestigationActivityPageV1): string {
    return canonicalInvestigationActivityBytes(page);
  }

  async resolve(
    actor: Actor,
    isAdmin: boolean,
    rawLocator: unknown,
  ): Promise<InvestigationResourceResolveV1> {
    let locator: InvestigationResourceLocatorV1;
    try {
      locator = typeof rawLocator === "string"
        ? parseCompactInvestigationLocator(rawLocator)
        : parseInvestigationLocatorInput(rawLocator);
    } catch (error) {
      if (error instanceof ContractViolation) throw new InvestigationActivityError("invalid_locator");
      throw new InvestigationActivityError("invalid_locator");
    }
    if (locator.installationId !== this.deps.installationId) {
      throw new InvestigationActivityError("not_found");
    }
    const investigation = await this.deps.cases.getCase(locator.investigationId, actor, isAdmin);
    if (!investigation) throw new InvestigationActivityError("not_found");
    const authorized = await this.authorizeLocator(actor, isAdmin, locator);
    if (!authorized) throw new InvestigationActivityError("not_found");
    return parseInvestigationResourceResolve({
      schemaId: INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
      locator,
      resourceKind: locator.kind,
      resourceLabel: authorized.label,
      investigationTitle: safeInvestigationTitle(investigation.title),
      revision: locator.revision ?? null,
      authorized: true,
    });
  }

  private async authorizeLocator(
    actor: Actor,
    isAdmin: boolean,
    locator: InvestigationResourceLocatorV1,
  ): Promise<{ label: string } | null> {
    const caseId = locator.investigationId;
    switch (locator.kind) {
      case "investigation":
        return locator.resourceId === caseId ? { label: resourceLabelForKind("investigation") } : null;
      case "investigation_stage":
        return { label: resourceLabelForKind("investigation_stage") };
      case "evidence_item": {
        const artifact = await this.deps.cases.getArtifact(caseId, locator.resourceId);
        if (artifact) {
          return {
            label: resourceLabelForKind(
              locator.kind,
              artifact.privacyClass === "share_safe" ? artifact.filename : null,
            ),
          };
        }
        return this.authorizeViaTimeline(caseId, locator);
      }
      case "evidence_context": {
        const snapshots = await this.deps.cases.listSnapshots(caseId, actor, isAdmin);
        if (snapshots.some((row) => row.id === locator.resourceId)) {
          return { label: resourceLabelForKind(locator.kind) };
        }
        return this.authorizeViaTimeline(caseId, locator);
      }
      case "discussion_message":
      case "hypothesis":
      case "action":
      case "observation": {
        try {
          const chain = await this.deps.cases.provenance(caseId, locator.resourceId);
          if (locator.revision !== undefined && !chain.some((row) => row.revision === locator.revision)) {
            return null;
          }
          const latest = chain[chain.length - 1];
          if (!latest || latest.caseId !== caseId) return null;
          if (!contributionKindMatchesLocator(latest.kind, locator.kind)) return null;
          return { label: resourceLabelForKind(locator.kind) };
        } catch {
          return this.authorizeViaTimeline(caseId, locator);
        }
      }
      case "timeline_event": {
        const seq = Number(locator.resourceId);
        const events = await this.deps.cases.listTimeline(caseId);
        return events.some((event) => event.seq === seq)
          ? { label: resourceLabelForKind("timeline_event", null, locator.resourceId) }
          : null;
      }
      default:
        return this.authorizeViaTimeline(caseId, locator);
    }
  }

  private async authorizeViaTimeline(
    caseId: string,
    locator: InvestigationResourceLocatorV1,
  ): Promise<{ label: string } | null> {
    const events = await this.deps.cases.listTimeline(caseId);
    const match = events.some((event) =>
      projectedLocatorMatches(this.deps.installationId, caseId, event, locator),
    );
    if (!match) return null;
    return {
      label: resourceLabelForKind(
        locator.kind,
        null,
        locator.kind === "timeline_event" ? locator.resourceId : null,
      ),
    };
  }
}

function contributionKindMatchesLocator(
  contributionKind: string,
  locatorKind: InvestigationResourceLocatorV1["kind"],
): boolean {
  switch (locatorKind) {
    case "discussion_message":
      return contributionKind === "message";
    case "hypothesis":
      return contributionKind === "hypothesis";
    case "action":
      return contributionKind === "action";
    case "observation":
      return contributionKind === "note" || contributionKind === "handoff";
    default:
      return false;
  }
}

function projectedLocatorMatches(
  installationId: string,
  caseId: string,
  event: TimelineRow,
  locator: InvestigationResourceLocatorV1,
): boolean {
  const projected = projectTimelineSource({
    installationId,
    source: { caseId, title: "Investigation", event: { ...event, caseId } },
  });
  if (!projected) return false;
  if (projected.item.locator.kind !== locator.kind) return false;
  if (projected.item.locator.resourceId !== locator.resourceId) return false;
  if (locator.revision !== undefined && projected.item.locator.revision !== locator.revision) {
    return false;
  }
  return true;
}
