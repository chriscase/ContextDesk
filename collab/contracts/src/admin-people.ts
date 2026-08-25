/**
 * Admin people-management operations: list/search installed users, inspect
 * effective roles/capabilities and their source, activate/suspend, grant or
 * revoke local capability grants, and preview a directory attribute map
 * against admin-supplied sample claims (never a live directory).
 *
 * Every mutation carries idempotencyKey so a retried request cannot double
 * -execute or double-audit; row-level mutations (status changes) also carry
 * expectedRevision for optimistic concurrency against the profile row.
 * Grant/revoke are idempotent set operations on a separate table and do not
 * need a revision token of their own.
 */
import { APP_ROLES, type AppRole } from "./auth.js";
import { CAPABILITIES, ROLE_CAPABILITIES, isCapability, type Capability } from "./capability.js";
import {
  mapDirectoryClaimsToProfileFields,
  parseDirectoryAttributeMap,
  type DirectoryAttributeMapV1,
  type DirectoryMappedField,
} from "./directory-mapping.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  PROFILE_PROVENANCE,
  PROFILE_STATUS,
  hasDangerousUnicode,
  parseUserProfile,
  type ProfileProvenance,
  type ProfileStatus,
  type UserProfileV1,
} from "./user-profile.js";

export const ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID =
  "cd-collab.admin_people_list_request.v1" as const;
export const ADMIN_PEOPLE_LIST_SCHEMA_ID = "cd-collab.admin_people_list.v1" as const;
export const ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID = "cd-collab.admin_people_effective.v1" as const;
export const ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID =
  "cd-collab.admin_people_status_request.v1" as const;
export const ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID =
  "cd-collab.admin_people_grant_request.v1" as const;
export const ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID =
  "cd-collab.admin_people_revoke_request.v1" as const;
export const ADMIN_PEOPLE_ERROR_SCHEMA_ID = "cd-collab.admin_people_error.v1" as const;
export const ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID =
  "cd-collab.admin_directory_mapping_preview_request.v1" as const;
export const ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID =
  "cd-collab.admin_directory_mapping_preview_response.v1" as const;

/**
 * Compatibility aliases for the canonical browser-mutation CSRF header
 * (`collab/contracts/src/csrf.ts`). People admin/self clients historically
 * imported these names; the header itself is now system-wide.
 */
export {
  COLLAB_CSRF_HEADER as ADMIN_PEOPLE_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE as ADMIN_PEOPLE_CSRF_HEADER_VALUE,
} from "./csrf.js";

export const ADMIN_PEOPLE_MAX_PAGE_SIZE = 50;
export const ADMIN_PEOPLE_SEARCH_MAX_LENGTH = 64;
export const ADMIN_PEOPLE_CURSOR_MAX_LENGTH = 256;
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
export const DIRECTORY_MAPPING_PREVIEW_MAX_CLAIMS = 32;
export const DIRECTORY_MAPPING_PREVIEW_MAX_KEY_LENGTH = 128;
export const DIRECTORY_MAPPING_PREVIEW_MAX_VALUE_LENGTH = 512;

function normalizeSearchTerm(term: string): string {
  return term.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function assertIdempotencyKey(path: string, value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ContractViolation(
      path,
      `expected ${IDEMPOTENCY_KEY_MIN_LENGTH} to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters from [A-Za-z0-9_.:-]`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// List / search
// ---------------------------------------------------------------------------

export interface AdminPeopleListRequestV1 {
  schemaId: typeof ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID;
  term: string;
  status: ProfileStatus | null;
  provenance: ProfileProvenance | null;
  /** Opaque keyset cursor from a prior response's nextCursor; null for the first page. */
  cursor: string | null;
  limit: number;
}

const listRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID)),
  term: f.req(f.str),
  status: f.nul(f.en(...PROFILE_STATUS)),
  provenance: f.nul(f.en(...PROFILE_PROVENANCE)),
  cursor: f.nul(f.str),
  limit: f.req(f.u64),
};

export function parseAdminPeopleListRequest(raw: unknown): AdminPeopleListRequestV1 {
  checkObject("$", listRequestShape, raw);
  const request = raw as AdminPeopleListRequestV1;
  const term = normalizeSearchTerm(request.term);
  if (term.length > ADMIN_PEOPLE_SEARCH_MAX_LENGTH) {
    throw new ContractViolation(
      "$.term",
      `expected at most ${ADMIN_PEOPLE_SEARCH_MAX_LENGTH} normalized characters`,
    );
  }
  if (hasDangerousUnicode(term)) {
    throw new ContractViolation("$.term", "control characters are not allowed");
  }
  if (request.limit < 1 || request.limit > ADMIN_PEOPLE_MAX_PAGE_SIZE) {
    throw new ContractViolation(
      "$.limit",
      `expected 1 to ${ADMIN_PEOPLE_MAX_PAGE_SIZE}`,
    );
  }
  if (request.cursor !== null && request.cursor.length > ADMIN_PEOPLE_CURSOR_MAX_LENGTH) {
    throw new ContractViolation(
      "$.cursor",
      `expected at most ${ADMIN_PEOPLE_CURSOR_MAX_LENGTH} characters`,
    );
  }
  return { ...request, term };
}

export interface AdminPeopleListResponseV1 {
  schemaId: typeof ADMIN_PEOPLE_LIST_SCHEMA_ID;
  people: UserProfileV1[];
  nextCursor: string | null;
}

export function parseAdminPeopleListResponse(raw: unknown): AdminPeopleListResponseV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new ContractViolation("$", "expected object");
  }
  const candidate = raw as { schemaId?: unknown; people?: unknown; nextCursor?: unknown };
  if (candidate.schemaId !== ADMIN_PEOPLE_LIST_SCHEMA_ID) {
    throw new ContractViolation("$.schemaId", `expected ${ADMIN_PEOPLE_LIST_SCHEMA_ID}`);
  }
  if (!Array.isArray(candidate.people)) {
    throw new ContractViolation("$.people", "expected array");
  }
  if (candidate.people.length > ADMIN_PEOPLE_MAX_PAGE_SIZE) {
    throw new ContractViolation("$.people", `expected at most ${ADMIN_PEOPLE_MAX_PAGE_SIZE} rows`);
  }
  if (candidate.nextCursor !== null && typeof candidate.nextCursor !== "string") {
    throw new ContractViolation("$.nextCursor", "expected string or null");
  }
  const people = candidate.people.map((row, index) => {
    try {
      return parseUserProfile(row);
    } catch (error) {
      throw new ContractViolation(
        `$.people[${index}]`,
        error instanceof Error ? error.message : "invalid profile row",
      );
    }
  });
  let previousUsername: string | null = null;
  for (const person of people) {
    if (previousUsername !== null && previousUsername.localeCompare(person.username) > 0) {
      throw new ContractViolation(
        "$.people",
        "rows are not sorted by username (deterministic ordering required)",
      );
    }
    previousUsername = person.username;
  }
  return {
    schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
    people,
    nextCursor: candidate.nextCursor as string | null,
  };
}

// ---------------------------------------------------------------------------
// Effective roles / capabilities + source
// ---------------------------------------------------------------------------

export interface EffectiveCapabilityV1 {
  capability: Capability;
  /** Roles this user currently holds that grant the capability by default. */
  viaRoles: AppRole[];
  viaLocalGrant: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
}

export interface AdminPeopleEffectiveV1 {
  schemaId: typeof ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID;
  userId: string;
  roles: AppRole[];
  capabilities: EffectiveCapabilityV1[];
}

export interface LocalCapabilityGrantV1 {
  capability: Capability;
  grantedBy: string;
  grantedAt: string;
}

/** Pure combination of the role matrix and a user's local grants into wire rows. */
export function buildEffectiveCapabilityRows(
  roles: readonly AppRole[],
  grants: readonly LocalCapabilityGrantV1[],
): EffectiveCapabilityV1[] {
  const grantByCapability = new Map(grants.map((grant) => [grant.capability, grant]));
  return CAPABILITIES.map((capability) => {
    const grantingRoles = APP_ROLES.filter((role) => ROLE_CAPABILITIES[role].includes(capability));
    const grant = grantByCapability.get(capability);
    return {
      capability,
      viaRoles: roles.filter((role) => grantingRoles.includes(role)),
      viaLocalGrant: grant !== undefined,
      grantedBy: grant?.grantedBy ?? null,
      grantedAt: grant?.grantedAt ?? null,
    };
  });
}

const effectiveShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID)),
  userId: f.req(f.nstr),
  roles: f.req(f.arr(f.en(...APP_ROLES))),
  capabilities: f.req(
    f.arr(
      f.obj({
        capability: f.req(f.en(...CAPABILITIES)),
        viaRoles: f.req(f.arr(f.en(...APP_ROLES))),
        viaLocalGrant: f.req(f.bool),
        grantedBy: f.nul(f.str),
        grantedAt: f.nul(f.str),
      }),
    ),
  ),
};

export function parseAdminPeopleEffective(raw: unknown): AdminPeopleEffectiveV1 {
  checkObject("$", effectiveShape, raw);
  return raw as AdminPeopleEffectiveV1;
}

// ---------------------------------------------------------------------------
// Status (activate / suspend / disable)
// ---------------------------------------------------------------------------

export interface AdminPeopleStatusRequestV1 {
  schemaId: typeof ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID;
  status: ProfileStatus;
  expectedRevision: number;
  idempotencyKey: string;
}

const statusRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID)),
  status: f.req(f.en(...PROFILE_STATUS)),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

export function parseAdminPeopleStatusRequest(raw: unknown): AdminPeopleStatusRequestV1 {
  checkObject("$", statusRequestShape, raw);
  const request = raw as AdminPeopleStatusRequestV1;
  assertIdempotencyKey("$.idempotencyKey", request.idempotencyKey);
  return request;
}

// ---------------------------------------------------------------------------
// Grant / revoke local capability
// ---------------------------------------------------------------------------

export interface AdminPeopleGrantRequestV1 {
  schemaId: typeof ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID;
  capability: Capability;
  idempotencyKey: string;
}

export interface AdminPeopleRevokeRequestV1 {
  schemaId: typeof ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID;
  capability: Capability;
  idempotencyKey: string;
}

const grantRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID)),
  capability: f.req(f.en(...CAPABILITIES)),
  idempotencyKey: f.req(f.nstr),
};

const revokeRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID)),
  capability: f.req(f.en(...CAPABILITIES)),
  idempotencyKey: f.req(f.nstr),
};

export function parseAdminPeopleGrantRequest(raw: unknown): AdminPeopleGrantRequestV1 {
  checkObject("$", grantRequestShape, raw);
  const request = raw as AdminPeopleGrantRequestV1;
  assertIdempotencyKey("$.idempotencyKey", request.idempotencyKey);
  if (!isCapability(request.capability)) {
    throw new ContractViolation("$.capability", "unknown capability");
  }
  return request;
}

export function parseAdminPeopleRevokeRequest(raw: unknown): AdminPeopleRevokeRequestV1 {
  checkObject("$", revokeRequestShape, raw);
  const request = raw as AdminPeopleRevokeRequestV1;
  assertIdempotencyKey("$.idempotencyKey", request.idempotencyKey);
  return request;
}

// ---------------------------------------------------------------------------
// Directory mapping preview (dry run against admin-supplied sample claims)
// ---------------------------------------------------------------------------

export interface AdminDirectoryMappingPreviewRequestV1 {
  schemaId: typeof ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID;
  map: DirectoryAttributeMapV1;
  /** Admin-supplied synthetic sample claims; this never contacts a real directory. */
  sampleClaims: Record<string, string>;
}

const PREVIEW_REQUEST_KEYS = new Set(["schemaId", "map", "sampleClaims"]);

function parseSampleClaims(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation("$.sampleClaims", "expected object");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > DIRECTORY_MAPPING_PREVIEW_MAX_CLAIMS) {
    throw new ContractViolation(
      "$.sampleClaims",
      `expected at most ${DIRECTORY_MAPPING_PREVIEW_MAX_CLAIMS} entries`,
    );
  }
  const claims: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > DIRECTORY_MAPPING_PREVIEW_MAX_KEY_LENGTH) {
      throw new ContractViolation(
        `$.sampleClaims.${key}`,
        `key expected 1 to ${DIRECTORY_MAPPING_PREVIEW_MAX_KEY_LENGTH} characters`,
      );
    }
    if (typeof value !== "string") {
      throw new ContractViolation(`$.sampleClaims.${key}`, "expected string value");
    }
    if (value.length > DIRECTORY_MAPPING_PREVIEW_MAX_VALUE_LENGTH) {
      throw new ContractViolation(
        `$.sampleClaims.${key}`,
        `expected at most ${DIRECTORY_MAPPING_PREVIEW_MAX_VALUE_LENGTH} characters`,
      );
    }
    if (hasDangerousUnicode(key)) {
      throw new ContractViolation(`$.sampleClaims.${key}`, "control characters are not allowed in keys");
    }
    claims[key] = value;
  }
  return claims;
}

export function parseAdminDirectoryMappingPreviewRequest(
  raw: unknown,
): AdminDirectoryMappingPreviewRequestV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation("$", "expected object");
  }
  const candidate = raw as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!PREVIEW_REQUEST_KEYS.has(key)) {
      throw new ContractViolation(`$.${key}`, "unknown key (contract drift)");
    }
  }
  if (candidate.schemaId !== ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID) {
    throw new ContractViolation(
      "$.schemaId",
      `expected ${ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID}`,
    );
  }
  const map = parseDirectoryAttributeMap(candidate.map);
  const sampleClaims = parseSampleClaims(candidate.sampleClaims);
  return {
    schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
    map,
    sampleClaims,
  };
}

export interface AdminDirectoryMappingPreviewResponseV1 {
  schemaId: typeof ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID;
  fields: Partial<Record<DirectoryMappedField, string>>;
  skipped: DirectoryMappedField[];
}

/** Runs the pure mapping function and shapes it as the preview response. */
export function computeDirectoryMappingPreview(
  request: AdminDirectoryMappingPreviewRequestV1,
): AdminDirectoryMappingPreviewResponseV1 {
  const result = mapDirectoryClaimsToProfileFields(request.sampleClaims, request.map);
  return {
    schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID,
    fields: result.fields,
    skipped: result.skipped,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AdminPeopleErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "stale_revision"
  | "duplicate_principal"
  | "collision"
  | "csrf_required"
  | "rate_limited"
  | "unavailable";

export interface AdminPeopleErrorV1 {
  schemaId: typeof ADMIN_PEOPLE_ERROR_SCHEMA_ID;
  error: AdminPeopleErrorCode;
}

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_PEOPLE_ERROR_SCHEMA_ID)),
  error: f.req(
    f.en(
      "invalid_request",
      "not_found",
      "forbidden",
      "stale_revision",
      "duplicate_principal",
      "collision",
      "csrf_required",
      "rate_limited",
      "unavailable",
    ),
  ),
};

export function parseAdminPeopleError(raw: unknown): AdminPeopleErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as AdminPeopleErrorV1;
}
