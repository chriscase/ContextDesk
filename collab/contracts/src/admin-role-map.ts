import { APP_ROLES, type AppRole } from "./auth.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID =
  "cd-collab.admin_role_mapping_list.v1" as const;
export const ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID =
  "cd-collab.admin_role_mapping_error.v1" as const;

export const ADMIN_ROLE_MAPPING_MAX_RESULTS = 500;
export const ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH = 512;

export type AdminRoleMappingErrorCode =
  | "invalid_request"
  | "not_found"
  | "unavailable";

export interface AdminRoleMappingV1 {
  group: string;
  role: AppRole;
}

export interface AdminRoleMappingListV1 {
  schemaId: typeof ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID;
  mappings: AdminRoleMappingV1[];
  limit: number;
  truncated: boolean;
}

export interface AdminRoleMappingErrorV1 {
  schemaId: typeof ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID;
  error: AdminRoleMappingErrorCode;
}

export interface AdminRoleMappingUpdateRequestV1 {
  group: string;
  role: AppRole;
}

export interface AdminRoleMappingRevokeRequestV1 {
  group: string;
}

const mappingShape: ObjectShape = {
  group: f.req(f.nstr),
  role: f.req(f.en(...APP_ROLES)),
};

const listShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID)),
  mappings: f.req(f.arr(f.obj(mappingShape))),
  limit: f.req(f.u64),
  truncated: f.req(f.bool),
};

const updateShape: ObjectShape = {
  group: f.req(f.nstr),
  role: f.req(f.en(...APP_ROLES)),
};

const revokeShape: ObjectShape = {
  group: f.req(f.nstr),
};

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID)),
  error: f.req(f.en("invalid_request", "not_found", "unavailable")),
};

export function normalizeAdminRoleGroup(group: string): string {
  const normalized = group.trim();
  if (normalized.length === 0) {
    throw new ContractViolation("$.group", "expected a non-empty directory group");
  }
  if (normalized.length > ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH) {
    throw new ContractViolation(
      "$.group",
      `expected at most ${ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH} characters`,
    );
  }
  if ([...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new ContractViolation("$.group", "control characters are not allowed");
  }
  return normalized;
}

export function parseAdminRoleMappingList(raw: unknown): AdminRoleMappingListV1 {
  checkObject("$", listShape, raw);
  const response = raw as AdminRoleMappingListV1;
  if (response.limit !== ADMIN_ROLE_MAPPING_MAX_RESULTS) {
    throw new ContractViolation(
      "$.limit",
      `expected ${ADMIN_ROLE_MAPPING_MAX_RESULTS}`,
    );
  }
  if (response.mappings.length > response.limit) {
    throw new ContractViolation("$.mappings", "result count exceeds declared limit");
  }
  let previous: string | null = null;
  const seen = new Set<string>();
  response.mappings.forEach((mapping, index) => {
    const group = normalizeAdminRoleGroup(mapping.group);
    if (group !== mapping.group) {
      throw new ContractViolation(`$.mappings[${index}].group`, "group is not normalized");
    }
    const comparisonKey = group.toLowerCase();
    if (seen.has(comparisonKey)) {
      throw new ContractViolation(`$.mappings[${index}].group`, "duplicate group mapping");
    }
    if (previous !== null && previous > comparisonKey) {
      throw new ContractViolation("$.mappings", "group mappings are not sorted");
    }
    seen.add(comparisonKey);
    previous = comparisonKey;
  });
  return response;
}

export function parseAdminRoleMappingUpdateRequest(
  raw: unknown,
): AdminRoleMappingUpdateRequestV1 {
  checkObject("$", updateShape, raw);
  const request = raw as AdminRoleMappingUpdateRequestV1;
  return { group: normalizeAdminRoleGroup(request.group), role: request.role };
}

export function parseAdminRoleMappingRevokeRequest(
  raw: unknown,
): AdminRoleMappingRevokeRequestV1 {
  checkObject("$", revokeShape, raw);
  const request = raw as AdminRoleMappingRevokeRequestV1;
  return { group: normalizeAdminRoleGroup(request.group) };
}

export function parseAdminRoleMappingError(raw: unknown): AdminRoleMappingErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as AdminRoleMappingErrorV1;
}
