/**
 * Authorized investigation collection query: filter, facets, and paging.
 *
 * Facets are counted over the membership-filtered set, never the current
 * page. Nothing here ranks, scores, or invents urgency, SLA, or completeness.
 */
import { createHash } from "node:crypto";
import {
  CASE_STATUSES,
  ContractViolation,
  INVESTIGATION_COLLECTION_LIMITS,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  canonicalJson,
  parseInvestigationCollectionPage,
  parseInvestigationOperationsQueuePage,
  softwareImpactDisplayLabel,
  softwareImpactIdentityKey,
  type CaseStatus,
  type CaseV1,
  type InvestigationCollectionFacetsV1,
  type InvestigationCollectionPageV1,
  type InvestigationCollectionQueryV1,
  type InvestigationCoordinationV1,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryV1,
  type SoftwareImpactIdentityV1,
} from "@cd-collab/contracts";
import {
  CollectionCursorError,
  mintInvestigationCollectionCursor,
  mintInvestigationOperationsQueueCursor,
  parseInvestigationCollectionCursor,
  parseInvestigationOperationsQueueCursor,
} from "./collection-cursor.js";
import type { InvestigationCollectionGraphSnapshot } from "./collection-graph.js";
import type { Actor, CaseCoordinationSnapshotRow, CaseRow } from "./store.js";

export class CollectionQueryError extends Error {
  constructor(readonly code: "malformed_cursor" | "stale_cursor") {
    super(code);
    this.name = "CollectionQueryError";
  }
}

const ARCHIVED_STATUS: CaseStatus = "archived";
const FILTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type CollectionFilters = Omit<InvestigationCollectionQueryV1, "schemaId">;

function emptyFacet(): { top: Array<{ key: string; count: number }>; otherCount: number } {
  return { top: [], otherCount: 0 };
}

function emptyImpactFacet(): {
  top: Array<{ key: string; count: number; identity: SoftwareImpactIdentityV1 }>;
  otherCount: number;
} {
  return { top: [], otherCount: 0 };
}

function asHttpQuery(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null && !Array.isArray(query)
    ? (query as Record<string, unknown>)
    : {};
}

function coerceBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function coerceUnsigned(value: unknown): unknown {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return value;
}

function coerceNullableString(value: unknown): unknown {
  if (value === "") return null;
  return value;
}

function coerceStatus(value: unknown): unknown {
  if (typeof value === "string") return [value];
  return value;
}

function coerceImpactIdentity(value: unknown): unknown {
  if (value === "" || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ContractViolation("$.impactIdentity", "expected object");
  }
}

/**
 * Coerce a GET query string into the InvestigationCollectionQueryV1 shape.
 * The frozen parser remains the only authority for validity.
 */
export function collectionQueryFromHttp(query: unknown): unknown {
  const raw = asHttpQuery(query);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    switch (key) {
      case "includeArchived":
        body[key] = coerceBoolean(value);
        break;
      case "limit":
        body[key] = coerceUnsigned(value);
        break;
      case "status":
        body[key] = coerceStatus(value);
        break;
      case "impactIdentity":
        body[key] = coerceImpactIdentity(value);
        break;
      case "entityId":
      case "contributorId":
      case "recordedFrom":
      case "recordedTo":
      case "cursor":
        body[key] = coerceNullableString(value);
        break;
      default:
        body[key] = value;
    }
  }
  return body;
}

export function requestsInvestigationCollectionPage(query: unknown): boolean {
  const raw = asHttpQuery(query);
  return Object.prototype.hasOwnProperty.call(raw, "schemaId");
}

export function requestsInvestigationOperationsQueuePage(query: unknown): boolean {
  const raw = asHttpQuery(query);
  return raw.schemaId === INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID;
}

export function collectionQueryFingerprint(query: InvestigationCollectionQueryV1): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        q: query.q,
        status: [...query.status].sort(),
        includeArchived: query.includeArchived,
        entityId: query.entityId,
        impactIdentity:
          query.impactIdentity === null ? null : softwareImpactIdentityKey(query.impactIdentity),
        contributorId: query.contributorId,
        recordedFrom: query.recordedFrom,
        recordedTo: query.recordedTo,
        limit: query.limit,
      }),
    )
    .digest("hex");
}

export function operationsQueueQueryFingerprint(
  query: InvestigationOperationsQueueQueryV1,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        q: query.q,
        status: [...query.status].sort(),
        includeArchived: query.includeArchived,
        entityId: query.entityId,
        impactIdentity:
          query.impactIdentity === null ? null : softwareImpactIdentityKey(query.impactIdentity),
        contributorId: query.contributorId,
        recordedFrom: query.recordedFrom,
        recordedTo: query.recordedTo,
        coordinationScope: query.coordinationScope,
        limit: query.limit,
      }),
    )
    .digest("hex");
}

function searchableValues(
  row: CaseRow,
  entityLabels: readonly string[],
): string[] {
  return [
    row.title,
    row.problemStatement,
    row.affectedParties,
    row.impact,
    row.scope,
    ...(row.openQuestions ?? []),
    row.status,
    row.severity,
    row.occurredAt ?? undefined,
    row.id,
    row.createdBy,
    row.createdByUsername,
    ...(row.participants ?? []).map((participant) => participant.username),
    ...Object.values(row.investigationContext ?? {}),
    ...entityLabels,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function matchesQuery(row: CaseRow, normalizedQuery: string, entityLabels: readonly string[]): boolean {
  if (!normalizedQuery) return true;
  return searchableValues(row, entityLabels).some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

function admitsArchived(query: CollectionFilters): boolean {
  return query.includeArchived || query.status.includes(ARCHIVED_STATUS);
}

function inRecordedRange(createdAt: string, query: CollectionFilters): boolean {
  const recorded = Date.parse(createdAt);
  if (!Number.isFinite(recorded)) return false;
  if (query.recordedFrom !== null && recorded < Date.parse(query.recordedFrom)) return false;
  if (query.recordedTo !== null && recorded > Date.parse(query.recordedTo)) return false;
  return true;
}

function hasContributor(row: CaseRow, contributorId: string): boolean {
  return row.participants.some((participant) => participant.identityId === contributorId);
}

function hasEntity(
  caseId: string,
  entityId: string,
  graph: InvestigationCollectionGraphSnapshot | null,
): boolean {
  if (!graph) return false;
  return graph.entitiesFor(caseId).some((link) => link.entityId === entityId);
}

function hasImpact(
  caseId: string,
  identity: SoftwareImpactIdentityV1,
  graph: InvestigationCollectionGraphSnapshot | null,
): boolean {
  if (!graph) return false;
  const wanted = softwareImpactIdentityKey(identity);
  return graph.impactsFor(caseId).some((row) => softwareImpactIdentityKey(row) === wanted);
}

function matchesFilters(
  row: CaseRow,
  query: CollectionFilters,
  graph: InvestigationCollectionGraphSnapshot | null,
  options: { ignoreArchivedVisibility: boolean },
): boolean {
  if (query.status.length > 0 && !query.status.includes(row.status)) return false;
  if (query.entityId !== null && !hasEntity(row.id, query.entityId, graph)) return false;
  if (query.impactIdentity !== null && !hasImpact(row.id, query.impactIdentity, graph)) return false;
  if (query.contributorId !== null && !hasContributor(row, query.contributorId)) return false;
  if (!inRecordedRange(row.createdAt, query)) return false;
  const entityLabels = graph ? graph.entitiesFor(row.id).map((link) => link.label) : [];
  if (!matchesQuery(row, query.q.toLocaleLowerCase(), entityLabels)) return false;
  if (!options.ignoreArchivedVisibility && row.status === ARCHIVED_STATUS && !admitsArchived(query)) {
    return false;
  }
  return true;
}

function compareRecordingOrder(left: CaseRow, right: CaseRow): number {
  const byCreated = right.createdAt.localeCompare(left.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
}

function comesAfterCursor(row: CaseRow, createdAt: string, id: string): boolean {
  if (row.createdAt < createdAt) return true;
  if (row.createdAt > createdAt) return false;
  return row.id > id;
}

function topBuckets(
  counts: Map<string, number>,
): { top: Array<{ key: string; count: number }>; otherCount: number } {
  const named = new Map<string, number>();
  let otherCount = 0;
  for (const [key, count] of counts) {
    if (count < 1) continue;
    if (FILTER_ID_RE.test(key)) named.set(key, count);
    else otherCount += count;
  }
  const ranked = [...named.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const top = ranked.slice(0, INVESTIGATION_COLLECTION_LIMITS.maxFacetTop).map(([key, count]) => ({
    key,
    count,
  }));
  otherCount += ranked.slice(INVESTIGATION_COLLECTION_LIMITS.maxFacetTop).reduce(
    (sum, [, count]) => sum + count,
    0,
  );
  return { top, otherCount };
}

function authorizedFacets(
  authorized: readonly CaseRow[],
  graph: InvestigationCollectionGraphSnapshot | null,
): InvestigationCollectionFacetsV1 {
  const statusCounts = new Map<string, number>(CASE_STATUSES.map((status) => [status, 0]));
  const entityCounts = new Map<string, number>();
  const contributorCounts = new Map<string, number>();
  const impactCounts = new Map<string, { count: number; identity: SoftwareImpactIdentityV1 }>();

  for (const row of authorized) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    const seenContributors = new Set<string>();
    for (const participant of row.participants) {
      if (seenContributors.has(participant.identityId)) continue;
      seenContributors.add(participant.identityId);
      contributorCounts.set(
        participant.identityId,
        (contributorCounts.get(participant.identityId) ?? 0) + 1,
      );
    }
    if (!graph) continue;
    const seenEntities = new Set<string>();
    for (const link of graph.entitiesFor(row.id)) {
      if (seenEntities.has(link.entityId)) continue;
      seenEntities.add(link.entityId);
      entityCounts.set(link.entityId, (entityCounts.get(link.entityId) ?? 0) + 1);
    }
    const seenImpacts = new Set<string>();
    for (const identity of graph.impactsFor(row.id)) {
      const key = softwareImpactIdentityKey(identity);
      if (seenImpacts.has(key)) continue;
      seenImpacts.add(key);
      const current = impactCounts.get(key);
      if (current) current.count += 1;
      else impactCounts.set(key, { count: 1, identity });
    }
  }

  const rankedImpacts = [...impactCounts.entries()]
    .filter(([, bucket]) => bucket.count > 0)
    .sort((left, right) => {
      const byCount = right[1].count - left[1].count;
      if (byCount !== 0) return byCount;
      return softwareImpactDisplayLabel(left[1].identity).localeCompare(
        softwareImpactDisplayLabel(right[1].identity),
      );
    });
  const impactTop = rankedImpacts
    .slice(0, INVESTIGATION_COLLECTION_LIMITS.maxFacetTop)
    .map(([, bucket]) => ({
      key: softwareImpactDisplayLabel(bucket.identity),
      count: bucket.count,
      identity: bucket.identity,
    }));
  const impactOther = rankedImpacts
    .slice(INVESTIGATION_COLLECTION_LIMITS.maxFacetTop)
    .reduce((sum, [, bucket]) => sum + bucket.count, 0);

  return {
    status: {
      top: CASE_STATUSES.map((status) => ({ key: status, count: statusCounts.get(status) ?? 0 })),
      otherCount: 0,
    },
    entity: graph ? topBuckets(entityCounts) : emptyFacet(),
    impactIdentity: graph
      ? { top: impactTop, otherCount: impactOther }
      : emptyImpactFacet(),
    contributor: topBuckets(contributorCounts),
  };
}

export function buildInvestigationCollectionPage(input: {
  authorized: readonly CaseRow[];
  query: InvestigationCollectionQueryV1;
  actor: Actor;
  isAdmin: boolean;
  graph: InvestigationCollectionGraphSnapshot | null;
  toCase: (row: CaseRow) => CaseV1;
}): InvestigationCollectionPageV1 {
  const { authorized, query, actor, isAdmin, graph, toCase } = input;
  const fingerprint = collectionQueryFingerprint(query);
  let cursor = null as ReturnType<typeof parseInvestigationCollectionCursor> | null;
  if (query.cursor !== null) {
    try {
      cursor = parseInvestigationCollectionCursor(query.cursor);
    } catch (error) {
      if (error instanceof CollectionCursorError) {
        throw new CollectionQueryError(error.code);
      }
      throw new CollectionQueryError("malformed_cursor");
    }
    if (
      cursor.actorId !== actor.id
      || cursor.isAdmin !== isAdmin
      || cursor.queryFingerprint !== fingerprint
    ) {
      throw new CollectionQueryError("stale_cursor");
    }
  }

  const matching: CaseRow[] = [];
  let hiddenArchivedCount = 0;
  for (const row of authorized) {
    const matchesExceptArchive = matchesFilters(row, query, graph, {
      ignoreArchivedVisibility: true,
    });
    if (!matchesExceptArchive) continue;
    if (row.status === ARCHIVED_STATUS && !admitsArchived(query)) {
      hiddenArchivedCount += 1;
      continue;
    }
    matching.push(row);
  }
  matching.sort(compareRecordingOrder);

  if (cursor) {
    const found = matching.some((row) => row.id === cursor.id && row.createdAt === cursor.createdAt);
    if (!found) throw new CollectionQueryError("stale_cursor");
  }
  const following = cursor
    ? matching.filter((row) => comesAfterCursor(row, cursor.createdAt, cursor.id))
    : matching;
  const items = following.slice(0, query.limit);
  const last = items[items.length - 1];
  const nextCursor =
    last && following.length > query.limit
      ? mintInvestigationCollectionCursor({
          actorId: actor.id,
          isAdmin,
          queryFingerprint: fingerprint,
          createdAt: last.createdAt,
          id: last.id,
        })
      : null;

  return parseInvestigationCollectionPage({
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: items.map((row) => toCase(row)),
    nextCursor,
    hiddenArchivedCount,
    facets: authorizedFacets(authorized, graph),
  });
}

export function buildInvestigationOperationsQueuePage(input: {
  authorized: readonly CaseCoordinationSnapshotRow[];
  query: InvestigationOperationsQueueQueryV1;
  actor: Actor;
  isAdmin: boolean;
  graph: InvestigationCollectionGraphSnapshot | null;
  toCase: (row: CaseRow) => CaseV1;
  toCoordination: (
    row: CaseRow,
    coordination: CaseCoordinationSnapshotRow["coordination"],
  ) => InvestigationCoordinationV1;
}): InvestigationOperationsQueuePageV1 {
  const { authorized, query, actor, isAdmin, graph, toCase, toCoordination } = input;
  const fingerprint = operationsQueueQueryFingerprint(query);
  let cursor = null as ReturnType<typeof parseInvestigationOperationsQueueCursor> | null;
  if (query.cursor !== null) {
    try {
      cursor = parseInvestigationOperationsQueueCursor(query.cursor);
    } catch (error) {
      if (error instanceof CollectionCursorError) {
        throw new CollectionQueryError(error.code);
      }
      throw new CollectionQueryError("malformed_cursor");
    }
    if (
      cursor.actorId !== actor.id
      || cursor.isAdmin !== isAdmin
      || cursor.queryFingerprint !== fingerprint
    ) {
      throw new CollectionQueryError("stale_cursor");
    }
  }

  const commonMatching: CaseCoordinationSnapshotRow[] = [];
  let hiddenArchivedCount = 0;
  for (const row of authorized) {
    const matchesExceptArchive = matchesFilters(row.caseRow, query, graph, {
      ignoreArchivedVisibility: true,
    });
    if (!matchesExceptArchive) continue;
    if (row.caseRow.status === ARCHIVED_STATUS && !admitsArchived(query)) {
      hiddenArchivedCount += 1;
      continue;
    }
    commonMatching.push(row);
  }

  const coordinationScopeCounts = {
    allVisible: commonMatching.length,
    mine: commonMatching.filter(
      (row) => row.coordination?.coordinator?.identityId === actor.id,
    ).length,
    unassigned: commonMatching.filter(
      (row) => row.coordination === null || row.coordination.coordinator === null,
    ).length,
  };
  const scoped = commonMatching.filter((row) => {
    switch (query.coordinationScope) {
      case "mine":
        return row.coordination?.coordinator?.identityId === actor.id;
      case "unassigned":
        return row.coordination === null || row.coordination.coordinator === null;
      case "all_visible":
        return true;
    }
  });
  scoped.sort((left, right) => compareRecordingOrder(left.caseRow, right.caseRow));

  if (cursor) {
    const found = scoped.some(
      (row) => row.caseRow.id === cursor.id && row.caseRow.createdAt === cursor.createdAt,
    );
    if (!found) throw new CollectionQueryError("stale_cursor");
  }
  const following = cursor
    ? scoped.filter((row) => comesAfterCursor(row.caseRow, cursor.createdAt, cursor.id))
    : scoped;
  const items = following.slice(0, query.limit);
  const last = items[items.length - 1];
  const nextCursor =
    last && following.length > query.limit
      ? mintInvestigationOperationsQueueCursor({
          actorId: actor.id,
          isAdmin,
          queryFingerprint: fingerprint,
          createdAt: last.caseRow.createdAt,
          id: last.caseRow.id,
        })
      : null;

  return parseInvestigationOperationsQueuePage({
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
    items: items.map((row) => ({
      investigation: toCase(row.caseRow),
      coordination: toCoordination(row.caseRow, row.coordination),
    })),
    nextCursor,
    hiddenArchivedCount,
    facets: authorizedFacets(authorized.map((row) => row.caseRow), graph),
    coordinationScopeCounts,
  });
}
