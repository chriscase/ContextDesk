/** Browser-safe contracts used by the Administration console. */
export { APP_ROLES } from "./auth.js";
export type { AppRole } from "./auth.js";

export {
  COMPONENT_HEALTH_COMPONENT_IDS,
  COMPONENT_HEALTH_NOTICES,
  COMPONENT_HEALTH_SCHEMA_ID,
  parseComponentHealthResponse,
} from "./component-health.js";
export type {
  ComponentHealthCompatibilityScope,
  ComponentHealthCompatibilityStatus,
  ComponentHealthCompatibilityV1,
  ComponentHealthComponentId,
  ComponentHealthComponentV1,
  ComponentHealthDataMode,
  ComponentHealthNotice,
  ComponentHealthProtocolV1,
  ComponentHealthReportStatus,
  ComponentHealthResponseV1,
  ComponentHealthSource,
  ComponentHealthStorageMigrationState,
  ComponentHealthStorageMigrationV1,
  ComponentHealthUpdateState,
  ComponentHealthUpdateV1,
} from "./component-health.js";

export {
  ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_DIRECTORY_MAX_RESULTS,
  ADMIN_DIRECTORY_MAX_TERM_LENGTH,
  ADMIN_DIRECTORY_MIN_TERM_LENGTH,
  ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
  normalizeAdminDirectorySearchTerm,
  parseAdminDirectoryError,
  parseAdminDirectoryGroupSearchResponse,
  parseAdminDirectoryIdentitySearchResponse,
  parseAdminDirectorySearchRequest,
} from "./admin-directory.js";
export type {
  AdminDirectoryErrorCode,
  AdminDirectoryErrorV1,
  AdminDirectoryGroupSearchResponseV1,
  AdminDirectoryGroupV1,
  AdminDirectoryIdentitySearchResponseV1,
  AdminDirectoryIdentityV1,
  AdminDirectorySearchRequestV1,
  AdminDirectorySource,
} from "./admin-directory.js";

export {
  ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  normalizeAdminRoleGroup,
  parseAdminRoleMappingError,
  parseAdminRoleMappingList,
  parseAdminRoleMappingRevokeRequest,
  parseAdminRoleMappingUpdateRequest,
} from "./admin-role-map.js";
export type {
  AdminRoleMappingErrorCode,
  AdminRoleMappingErrorV1,
  AdminRoleMappingListV1,
  AdminRoleMappingRevokeRequestV1,
  AdminRoleMappingUpdateRequestV1,
  AdminRoleMappingV1,
} from "./admin-role-map.js";
