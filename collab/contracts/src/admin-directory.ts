import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID =
  "cd-collab.admin_directory_search_request.v1" as const;
export const ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID =
  "cd-collab.admin_directory_identities.v1" as const;
export const ADMIN_DIRECTORY_GROUPS_SCHEMA_ID =
  "cd-collab.admin_directory_groups.v1" as const;
export const ADMIN_DIRECTORY_ERROR_SCHEMA_ID =
  "cd-collab.admin_directory_error.v1" as const;

export const ADMIN_DIRECTORY_MIN_TERM_LENGTH = 2;
export const ADMIN_DIRECTORY_MAX_TERM_LENGTH = 64;
export const ADMIN_DIRECTORY_MAX_RESULTS = 20;

export type AdminDirectorySource = "ldap" | "local";
export type AdminDirectoryErrorCode = "invalid_request" | "directory_unavailable";

export interface AdminDirectorySearchRequestV1 {
  schemaId: typeof ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID;
  term: string;
}

export interface AdminDirectoryIdentityV1 {
  id: string;
  username: string;
  displayName: string;
  source: AdminDirectorySource;
}

export interface AdminDirectoryGroupV1 {
  dn: string;
  name: string;
  source: AdminDirectorySource;
}

export interface AdminDirectoryIdentitySearchResponseV1 {
  schemaId: typeof ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID;
  results: AdminDirectoryIdentityV1[];
}

export interface AdminDirectoryGroupSearchResponseV1 {
  schemaId: typeof ADMIN_DIRECTORY_GROUPS_SCHEMA_ID;
  results: AdminDirectoryGroupV1[];
}

export interface AdminDirectoryErrorV1 {
  schemaId: typeof ADMIN_DIRECTORY_ERROR_SCHEMA_ID;
  error: AdminDirectoryErrorCode;
}

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID)),
  term: f.req(f.str),
};

const identityShape: ObjectShape = {
  id: f.req(f.str),
  username: f.req(f.str),
  displayName: f.req(f.str),
  source: f.req(f.en("ldap", "local")),
};

const groupShape: ObjectShape = {
  dn: f.req(f.str),
  name: f.req(f.str),
  source: f.req(f.en("ldap", "local")),
};

const identityResponseShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID)),
  results: f.req(f.arr(f.obj(identityShape))),
};

const groupResponseShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_DIRECTORY_GROUPS_SCHEMA_ID)),
  results: f.req(f.arr(f.obj(groupShape))),
};

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(ADMIN_DIRECTORY_ERROR_SCHEMA_ID)),
  error: f.req(f.en("invalid_request", "directory_unavailable")),
};

export function normalizeAdminDirectorySearchTerm(term: string): string {
  return term.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function parseAdminDirectorySearchRequest(
  raw: unknown,
): AdminDirectorySearchRequestV1 {
  checkObject("$", requestShape, raw);
  const request = raw as AdminDirectorySearchRequestV1;
  const term = normalizeAdminDirectorySearchTerm(request.term);
  if (term.length < ADMIN_DIRECTORY_MIN_TERM_LENGTH) {
    throw new ContractViolation(
      "$.term",
      `expected at least ${ADMIN_DIRECTORY_MIN_TERM_LENGTH} normalized characters`,
    );
  }
  if (term.length > ADMIN_DIRECTORY_MAX_TERM_LENGTH) {
    throw new ContractViolation(
      "$.term",
      `expected at most ${ADMIN_DIRECTORY_MAX_TERM_LENGTH} normalized characters`,
    );
  }
  return { schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID, term };
}

export function parseAdminDirectoryIdentitySearchResponse(
  raw: unknown,
): AdminDirectoryIdentitySearchResponseV1 {
  checkObject("$", identityResponseShape, raw);
  const response = raw as AdminDirectoryIdentitySearchResponseV1;
  validateResults(response.results, (item) => [item.id, item.username, item.displayName]);
  return response;
}

export function parseAdminDirectoryGroupSearchResponse(
  raw: unknown,
): AdminDirectoryGroupSearchResponseV1 {
  checkObject("$", groupResponseShape, raw);
  const response = raw as AdminDirectoryGroupSearchResponseV1;
  validateResults(response.results, (item) => [item.dn, item.name]);
  return response;
}

export function parseAdminDirectoryError(raw: unknown): AdminDirectoryErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as AdminDirectoryErrorV1;
}

function validateResults<T>(
  results: readonly T[],
  strings: (item: T) => readonly string[],
): void {
  if (results.length > ADMIN_DIRECTORY_MAX_RESULTS) {
    throw new ContractViolation(
      "$.results",
      `expected at most ${ADMIN_DIRECTORY_MAX_RESULTS} results`,
    );
  }
  results.forEach((item, index) => {
    for (const value of strings(item)) {
      if (value.trim().length === 0) {
        throw new ContractViolation(`$.results[${index}]`, "empty projected field");
      }
    }
  });
}
