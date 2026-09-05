/**
 * Browser-safe wire contracts for the bounded Operations Queue V1 collection.
 *
 * This composes, rather than changes, Investigation Collection V1. The server
 * still owns visibility, capability checks, cursor minting, ordering, and the
 * authoritative coordination projection. This contract adds no priority,
 * ranking, SLA, lease, presence, automatic assignment, or status behavior.
 */
import { CASE_STATUSES, parseCase, type CaseV1 } from "./case.js";
import {
  INVESTIGATION_COLLECTION_LIMITS,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  parseInvestigationCollectionPage,
  parseInvestigationCollectionQuery,
  type InvestigationCollectionFacetsV1,
  type InvestigationCollectionQueryV1,
} from "./investigation-collection-browser.js";
import {
  parseInvestigationCoordination,
  type InvestigationCoordinationV1,
} from "./investigation-coordination.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID =
  "cd-collab.investigation_operations_queue_query.v1" as const;
export const INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID =
  "cd-collab.investigation_operations_queue_page.v1" as const;

export const INVESTIGATION_OPERATIONS_QUEUE_COORDINATION_SCOPES = [
  "all_visible",
  "mine",
  "unassigned",
] as const;
export type InvestigationOperationsQueueCoordinationScopeV1 =
  (typeof INVESTIGATION_OPERATIONS_QUEUE_COORDINATION_SCOPES)[number];

export const INVESTIGATION_OPERATIONS_QUEUE_LIMITS = INVESTIGATION_COLLECTION_LIMITS;

export interface InvestigationOperationsQueueQueryV1
  extends Omit<InvestigationCollectionQueryV1, "schemaId"> {
  schemaId: typeof INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID;
  coordinationScope: InvestigationOperationsQueueCoordinationScopeV1;
}

export interface InvestigationOperationsQueueRowV1 {
  investigation: CaseV1;
  coordination: InvestigationCoordinationV1;
}

export interface InvestigationOperationsQueueCoordinationScopeCountsV1 {
  allVisible: number;
  mine: number;
  unassigned: number;
}

export interface InvestigationOperationsQueuePageV1 {
  schemaId: typeof INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID;
  items: InvestigationOperationsQueueRowV1[];
  nextCursor: string | null;
  hiddenArchivedCount: number;
  facets: InvestigationCollectionFacetsV1;
  coordinationScopeCounts: InvestigationOperationsQueueCoordinationScopeCountsV1;
}

const queryShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID)),
  q: f.opt(f.str),
  status: f.opt(f.arr(f.en(...CASE_STATUSES))),
  includeArchived: f.opt(f.bool),
  entityId: f.optNul(f.nstr),
  // The collection parser owns this nested object's exact shape.
  impactIdentity: f.optNul(f.str),
  contributorId: f.optNul(f.nstr),
  recordedFrom: f.optNul(f.nstr),
  recordedTo: f.optNul(f.nstr),
  cursor: f.optNul(f.str),
  limit: f.opt(f.u64),
  coordinationScope: f.opt(f.en(...INVESTIGATION_OPERATIONS_QUEUE_COORDINATION_SCOPES)),
};

const pageShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID)),
  // Nested values are replaced by sentinels before this outer shape check.
  items: f.req(f.arr(f.obj({}))),
  nextCursor: f.nul(f.str),
  hiddenArchivedCount: f.req(f.u64),
  facets: f.req(f.str),
  coordinationScopeCounts: f.req(f.str),
};

const rowShape: ObjectShape = {
  investigation: f.req(f.str),
  coordination: f.req(f.str),
};

const coordinationScopeCountsShape: ObjectShape = {
  allVisible: f.req(f.u64),
  mine: f.req(f.u64),
  unassigned: f.req(f.u64),
};

function requirePlainObject(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

function deepFrozenCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFrozenCopy(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      copy[key] = deepFrozenCopy(nested);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

function parseQueueRow(
  raw: unknown,
  index: number,
): InvestigationOperationsQueueRowV1 {
  const path = `$.items[${index}]`;
  const record = requirePlainObject(path, raw);
  checkObject(path, rowShape, {
    ...record,
    ...(Object.prototype.hasOwnProperty.call(record, "investigation")
      ? { investigation: "nested" }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "coordination")
      ? { coordination: "nested" }
      : {}),
  });

  let investigation: CaseV1;
  try {
    investigation = parseCase(record.investigation);
  } catch (error) {
    if (error instanceof ContractViolation) {
      const suffix = error.path.startsWith("$") ? error.path.slice(1) : `.${error.path}`;
      throw new ContractViolation(`${path}.investigation${suffix}`, error.detail);
    }
    throw error;
  }
  const coordination = parseInvestigationCoordination(
    record.coordination,
    `${path}.coordination`,
  );

  if (coordination.investigationId !== investigation.id) {
    throw new ContractViolation(
      `${path}.coordination.investigationId`,
      "must equal the row investigation identity",
    );
  }
  if (coordination.archived !== (investigation.status === "archived")) {
    throw new ContractViolation(
      `${path}.coordination.archived`,
      "must equal the authoritative investigation archived state",
    );
  }

  return { investigation, coordination };
}

function assertUniqueCaseIdentities(items: InvestigationOperationsQueueRowV1[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.investigation.id)) {
      throw new ContractViolation(
        `$.items[${index}].investigation.id`,
        "duplicate case identity",
      );
    }
    seen.add(item.investigation.id);
  });
}

function parseCoordinationScopeCounts(
  raw: unknown,
): InvestigationOperationsQueueCoordinationScopeCountsV1 {
  checkObject("$.coordinationScopeCounts", coordinationScopeCountsShape, raw);
  const counts = raw as InvestigationOperationsQueueCoordinationScopeCountsV1;
  if (counts.mine > counts.allVisible) {
    throw new ContractViolation(
      "$.coordinationScopeCounts.mine",
      "must not exceed allVisible",
    );
  }
  if (counts.unassigned > counts.allVisible) {
    throw new ContractViolation(
      "$.coordinationScopeCounts.unassigned",
      "must not exceed allVisible",
    );
  }
  if (counts.mine > counts.allVisible - counts.unassigned) {
    throw new ContractViolation(
      "$.coordinationScopeCounts",
      "mine and unassigned are disjoint subsets of allVisible",
    );
  }
  return { ...counts };
}

export function parseInvestigationOperationsQueueQuery(
  raw: unknown,
): InvestigationOperationsQueueQueryV1 {
  const record = requirePlainObject("$", raw);
  const shallow = { ...record };
  if (record.impactIdentity !== null && record.impactIdentity !== undefined) {
    shallow.impactIdentity = "nested";
  }
  checkObject("$", queryShape, shallow);
  const { coordinationScope: _coordinationScope, ...collectionFields } = record;
  const collection = parseInvestigationCollectionQuery({
    ...collectionFields,
    schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  });
  const parsed: InvestigationOperationsQueueQueryV1 = {
    ...collection,
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
    coordinationScope:
      (record.coordinationScope as InvestigationOperationsQueueCoordinationScopeV1 | undefined) ??
      "all_visible",
  };
  return deepFrozenCopy(parsed);
}

export function parseInvestigationOperationsQueuePage(
  raw: unknown,
): InvestigationOperationsQueuePageV1 {
  const record = requirePlainObject("$", raw);
  if (!Array.isArray(record.items)) {
    throw new ContractViolation("$.items", "expected array");
  }
  if (record.items.length > INVESTIGATION_OPERATIONS_QUEUE_LIMITS.maxLimit) {
    throw new ContractViolation(
      "$.items",
      `expected at most ${INVESTIGATION_OPERATIONS_QUEUE_LIMITS.maxLimit} items`,
    );
  }
  checkObject("$", pageShape, {
    ...record,
    items: record.items.map(() => ({})),
    ...(Object.prototype.hasOwnProperty.call(record, "facets") ? { facets: "nested" } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "coordinationScopeCounts")
      ? { coordinationScopeCounts: "nested" }
      : {}),
  });

  const items = record.items.map((item, index) => parseQueueRow(item, index));
  assertUniqueCaseIdentities(items);
  const collectionPage = parseInvestigationCollectionPage({
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: items.map((item) => item.investigation),
    nextCursor: record.nextCursor,
    hiddenArchivedCount: record.hiddenArchivedCount,
    facets: record.facets,
  });
  const coordinationScopeCounts = parseCoordinationScopeCounts(
    record.coordinationScopeCounts,
  );
  if (items.length > coordinationScopeCounts.allVisible) {
    throw new ContractViolation(
      "$.coordinationScopeCounts.allVisible",
      "must cover every visible row in the page",
    );
  }
  const returnedUnassignedCount = items.reduce(
    (count, item) => count + (item.coordination.coordinator === null ? 1 : 0),
    0,
  );
  if (returnedUnassignedCount > coordinationScopeCounts.unassigned) {
    throw new ContractViolation(
      "$.coordinationScopeCounts.unassigned",
      "must cover every returned unassigned row",
    );
  }
  const returnedAssignedCount = items.length - returnedUnassignedCount;
  const visibleAssignedCount =
    coordinationScopeCounts.allVisible - coordinationScopeCounts.unassigned;
  if (returnedAssignedCount > visibleAssignedCount) {
    throw new ContractViolation(
      "$.coordinationScopeCounts.allVisible",
      "assigned remainder must cover every returned assigned row",
    );
  }

  return deepFrozenCopy({
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
    items,
    nextCursor: collectionPage.nextCursor,
    hiddenArchivedCount: collectionPage.hiddenArchivedCount,
    facets: collectionPage.facets,
    coordinationScopeCounts,
  });
}
