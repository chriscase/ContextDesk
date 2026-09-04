/**
 * Browser-safe read contract for the investigation collection query.
 *
 * This is the versioned successor to client-side filtering of `case_list.v1`.
 * The unpaged list envelope stays valid; this module adds a deny-unknown query
 * and a paged response the browser can check without decoding the cursor.
 * Cursor minting stays server-owned. Nothing here ranks, scores, or invents
 * urgency, SLA, completeness, or build order.
 */
import {
  CASE_STATUSES,
  parseCase,
  type CaseStatus,
  type CaseV1,
} from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  normalizeSoftwareImpactIdentity,
  type SoftwareImpactIdentityV1,
} from "./investigation-software-impact.js";
import { isIsoInstant } from "./temporal.js";

export const INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID =
  "cd-collab.investigation_collection_query.v1" as const;
export const INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID =
  "cd-collab.investigation_collection_page.v1" as const;

export const INVESTIGATION_COLLECTION_STATUSES = CASE_STATUSES;
export type InvestigationCollectionStatusV1 = CaseStatus;

export const INVESTIGATION_COLLECTION_FACET_FAMILIES = [
  "status",
  "entity",
  "impactIdentity",
  "contributor",
] as const;
export type InvestigationCollectionFacetFamilyV1 =
  (typeof INVESTIGATION_COLLECTION_FACET_FAMILIES)[number];

export const INVESTIGATION_COLLECTION_LIMITS = {
  defaultLimit: 50,
  maxLimit: 100,
  maxQueryChars: 512,
  minCursorChars: 8,
  maxCursorChars: 4_096,
  maxFilterIdChars: 128,
  maxFacetTop: 32,
  maxFacetKeyChars: 1_024,
} as const;

const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{8,4096}$/;
const FILTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface InvestigationCollectionQueryV1 {
  schemaId: typeof INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID;
  q: string;
  status: InvestigationCollectionStatusV1[];
  includeArchived: boolean;
  entityId: string | null;
  impactIdentity: SoftwareImpactIdentityV1 | null;
  contributorId: string | null;
  recordedFrom: string | null;
  recordedTo: string | null;
  cursor: string | null;
  limit: number;
}

export interface InvestigationCollectionFacetBucketV1 {
  key: string;
  count: number;
}

export interface InvestigationCollectionFacetV1 {
  top: InvestigationCollectionFacetBucketV1[];
  otherCount: number;
}

export interface InvestigationCollectionFacetsV1 {
  status: InvestigationCollectionFacetV1;
  entity: InvestigationCollectionFacetV1;
  impactIdentity: InvestigationCollectionFacetV1;
  contributor: InvestigationCollectionFacetV1;
}

export interface InvestigationCollectionPageV1 {
  schemaId: typeof INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID;
  items: CaseV1[];
  nextCursor: string | null;
  hiddenArchivedCount: number;
  facets: InvestigationCollectionFacetsV1;
}

const impactIdentityShape: ObjectShape = {
  productName: f.req(f.str),
  version: f.req(f.str),
  build: f.req(f.str),
  component: f.req(f.str),
  environment: f.req(f.str),
};

const queryShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID)),
  q: f.opt(f.str),
  status: f.opt(f.arr(f.en(...CASE_STATUSES))),
  includeArchived: f.opt(f.bool),
  entityId: f.opt(f.nstr),
  impactIdentity: f.opt(f.obj(impactIdentityShape)),
  contributorId: f.opt(f.nstr),
  recordedFrom: f.opt(f.nstr),
  recordedTo: f.opt(f.nstr),
  cursor: f.optNul(f.str),
  limit: f.opt(f.u64),
};

const facetBucketShape: ObjectShape = {
  key: f.req(f.nstr),
  count: f.req(f.u64),
};

const facetShape: ObjectShape = {
  top: f.req(f.arr(f.obj(facetBucketShape))),
  otherCount: f.req(f.u64),
};

const facetsShape: ObjectShape = {
  status: f.req(f.obj(facetShape)),
  entity: f.req(f.obj(facetShape)),
  impactIdentity: f.req(f.obj(facetShape)),
  contributor: f.req(f.obj(facetShape)),
};

const pageShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID)),
  // Placeholder only: each item is replaced with `{}` before checkObject, then
  // parsed with `parseCase` so this module cannot drift from CaseV1.
  items: f.req(f.arr(f.obj({}))),
  nextCursor: f.nul(f.str),
  hiddenArchivedCount: f.req(f.u64),
  facets: f.req(f.obj(facetsShape)),
};

function hasControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x2028 && code <= 0x202f) return true;
    if (code >= 0x2060 && code <= 0x206f) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}

function requirePlainObject(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

function assertFilterId(path: string, value: string): void {
  if (value.length > INVESTIGATION_COLLECTION_LIMITS.maxFilterIdChars || !FILTER_ID_RE.test(value)) {
    throw new ContractViolation(path, "expected a bounded identity token");
  }
}

function assertOpaqueCursor(path: string, value: string): void {
  if (!OPAQUE_CURSOR_RE.test(value)) {
    throw new ContractViolation(path, "expected a bounded opaque cursor");
  }
}

function assertRecordedInstant(path: string, value: string): void {
  if (!isIsoInstant(value)) {
    throw new ContractViolation(path, "expected an ISO-8601 instant with an explicit offset");
  }
}

function assertQueryText(path: string, value: string): string {
  if (value.length > INVESTIGATION_COLLECTION_LIMITS.maxQueryChars) {
    throw new ContractViolation(
      path,
      `exceeds ${INVESTIGATION_COLLECTION_LIMITS.maxQueryChars} characters`,
    );
  }
  if (hasControlChars(value)) {
    throw new ContractViolation(path, "must be a single line of text");
  }
  return value.trim();
}

function assertUniqueStatuses(status: CaseStatus[]): void {
  const seen = new Set<CaseStatus>();
  status.forEach((value, index) => {
    if (seen.has(value)) {
      throw new ContractViolation(`$.status[${index}]`, "duplicate status filter");
    }
    seen.add(value);
  });
}

function parseCollectionCase(raw: unknown, index: number): CaseV1 {
  try {
    return parseCase(raw);
  } catch (error) {
    if (error instanceof ContractViolation) {
      const suffix = error.path.startsWith("$") ? error.path.slice(1) : `.${error.path}`;
      throw new ContractViolation(`$.items[${index}]${suffix}`, error.detail);
    }
    throw error;
  }
}

function assertFacet(
  path: string,
  facet: InvestigationCollectionFacetV1,
  family: InvestigationCollectionFacetFamilyV1,
): void {
  if (facet.top.length > INVESTIGATION_COLLECTION_LIMITS.maxFacetTop) {
    throw new ContractViolation(`${path}.top`, "facet top exceeds cap");
  }
  const seen = new Set<string>();
  facet.top.forEach((bucket, index) => {
    const keyPath = `${path}.top[${index}].key`;
    if (hasControlChars(bucket.key) || bucket.key.length > INVESTIGATION_COLLECTION_LIMITS.maxFacetKeyChars) {
      throw new ContractViolation(keyPath, "facet key is not bounded display text");
    }
    if (family === "status") {
      if (!(CASE_STATUSES as readonly string[]).includes(bucket.key)) {
        throw new ContractViolation(keyPath, "status facet key is not a recorded case status");
      }
    } else if (family !== "impactIdentity" && !FILTER_ID_RE.test(bucket.key)) {
      throw new ContractViolation(keyPath, "expected a bounded identity token");
    }
    if (seen.has(bucket.key)) {
      throw new ContractViolation(keyPath, "duplicate facet count identity");
    }
    seen.add(bucket.key);
  });
}

function assertItemIdentities(items: CaseV1[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      throw new ContractViolation(`$.items[${index}].id`, "duplicate case identity");
    }
    seen.add(item.id);
    const participants = new Set<string>();
    item.participants.forEach((participant, participantIndex) => {
      if (participants.has(participant.identityId)) {
        throw new ContractViolation(
          `$.items[${index}].participants[${participantIndex}].identityId`,
          "duplicate participant identity",
        );
      }
      participants.add(participant.identityId);
    });
  });
}

export function parseInvestigationCollectionQuery(raw: unknown): InvestigationCollectionQueryV1 {
  checkObject("$", queryShape, raw);
  const body = raw as {
    schemaId: typeof INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID;
    q?: string;
    status?: CaseStatus[];
    includeArchived?: boolean;
    entityId?: string;
    impactIdentity?: SoftwareImpactIdentityV1;
    contributorId?: string;
    recordedFrom?: string;
    recordedTo?: string;
    cursor?: string | null;
    limit?: number;
  };
  const q = assertQueryText("$.q", body.q ?? "");
  const status = body.status ? [...body.status] : [];
  assertUniqueStatuses(status);
  if (body.entityId !== undefined) assertFilterId("$.entityId", body.entityId);
  if (body.contributorId !== undefined) assertFilterId("$.contributorId", body.contributorId);
  const impactIdentity =
    body.impactIdentity === undefined
      ? null
      : normalizeSoftwareImpactIdentity(body.impactIdentity, "$.impactIdentity");
  const recordedFrom = body.recordedFrom ?? null;
  const recordedTo = body.recordedTo ?? null;
  if (recordedFrom !== null) assertRecordedInstant("$.recordedFrom", recordedFrom);
  if (recordedTo !== null) assertRecordedInstant("$.recordedTo", recordedTo);
  if (recordedFrom !== null && recordedTo !== null && Date.parse(recordedFrom) > Date.parse(recordedTo)) {
    throw new ContractViolation("$.recordedTo", "range end must not precede range start");
  }
  const cursor = body.cursor ?? null;
  if (cursor !== null) assertOpaqueCursor("$.cursor", cursor);
  const requestedLimit = body.limit ?? 0;
  if (requestedLimit > INVESTIGATION_COLLECTION_LIMITS.maxLimit) {
    throw new ContractViolation("$.limit", "page size exceeds cap");
  }
  return {
    schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
    q,
    status,
    includeArchived: body.includeArchived ?? false,
    entityId: body.entityId ?? null,
    impactIdentity,
    contributorId: body.contributorId ?? null,
    recordedFrom,
    recordedTo,
    cursor,
    limit: requestedLimit === 0 ? INVESTIGATION_COLLECTION_LIMITS.defaultLimit : requestedLimit,
  };
}

export function parseInvestigationCollectionPage(raw: unknown): InvestigationCollectionPageV1 {
  const record = requirePlainObject("$", raw);
  if (!Array.isArray(record.items)) {
    throw new ContractViolation("$.items", "expected array");
  }
  checkObject("$", pageShape, { ...record, items: record.items.map(() => ({})) });
  if (record.items.length > INVESTIGATION_COLLECTION_LIMITS.maxLimit) {
    throw new ContractViolation("$.items", `expected at most ${INVESTIGATION_COLLECTION_LIMITS.maxLimit} items`);
  }
  const page = raw as InvestigationCollectionPageV1;
  const items = record.items.map((item, index) => parseCollectionCase(item, index));
  assertItemIdentities(items);
  if (page.nextCursor !== null) assertOpaqueCursor("$.nextCursor", page.nextCursor);
  assertFacet("$.facets.status", page.facets.status, "status");
  assertFacet("$.facets.entity", page.facets.entity, "entity");
  assertFacet("$.facets.impactIdentity", page.facets.impactIdentity, "impactIdentity");
  assertFacet("$.facets.contributor", page.facets.contributor, "contributor");
  return {
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items,
    nextCursor: page.nextCursor,
    hiddenArchivedCount: page.hiddenArchivedCount,
    facets: page.facets,
  };
}
