/** Browser-safe contracts used by the Administration console. */
export { APP_ROLES } from "./auth.js";
export type { AppRole } from "./auth.js";
export {
  MODEL_PRIVATE_EVIDENCE_RULES,
  MODEL_PURPOSES,
  MODEL_PURPOSE_POLICY_SCHEMA_ID,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
} from "./model-purpose-policy-shared.js";
export type {
  ModelPrivateEvidenceRule,
  ModelPurpose,
  ModelPurposePolicyInputV1,
  ModelPurposePolicyV1,
  ModelPurposeRuleV1,
} from "./model-purpose-policy-shared.js";

export {
  UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
  UI_STRATEGY_EFFECTIVE_SOURCES,
  UI_STRATEGY_ERROR_CODES,
  UI_STRATEGY_ERROR_SCHEMA_ID,
  UI_STRATEGY_IDS,
  UI_STRATEGY_POLICY_SCHEMA_ID,
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
  UI_STRATEGY_SELECTION_MODES,
  parseUiStrategyEffective,
  parseUiStrategyError,
  parseUiStrategyPolicy,
  parseUiStrategyPolicyInput,
  parseUiStrategyPreferenceUpdate,
} from "./ui-strategy-governance-shared.js";
export type {
  UiStrategyEffectiveSource,
  UiStrategyEffectiveV1,
  UiStrategyErrorCode,
  UiStrategyErrorV1,
  UiStrategyGovernancePolicyInputV1,
  UiStrategyGovernancePolicyV1,
  UiStrategyId,
  UiStrategyInstanceRuleV1,
  UiStrategyPreferenceUpdateV1,
  UiStrategyRoleRuleV1,
  UiStrategySelectionMode,
} from "./ui-strategy-governance-shared.js";

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

export {
  CAPABILITIES,
  CAPABILITY_MODEL_VERSION,
  ROLE_CAPABILITIES,
  hasCapability,
  isCapability,
  resolveCapabilities,
  roleCapabilities,
} from "./capability.js";
export type { Capability } from "./capability.js";

export {
  AVATAR_KINDS,
  DIRECTORY_SYNCED_FIELDS,
  DIRECTORY_SYNC_STATUSES,
  LOCAL_ONLY_FIELDS,
  PROFILE_CONTACT_EMAIL_MAX,
  PROFILE_CONTACT_OTHER_MAX,
  PROFILE_CUSTOM_ATTR_KEY_MAX,
  PROFILE_CUSTOM_ATTR_KEY_PATTERN,
  PROFILE_CUSTOM_ATTR_MAX_COUNT,
  PROFILE_CUSTOM_ATTR_VALUE_MAX,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_PROVENANCE,
  PROFILE_ROLE_TITLE_MAX,
  PROFILE_STATUS,
  PROFILE_TEAM_MAX,
  USER_PROFILE_ERROR_SCHEMA_ID,
  USER_PROFILE_SCHEMA_ID,
  USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
  assertProfileUpdateAllowed,
  hasDangerousUnicode,
  isProfileFieldSelfEditable,
  normalizeCustomAttributes,
  normalizeDisplayName,
  parseUserProfile,
  parseUserProfileError,
  parseUserProfileUpdateRequest,
} from "./user-profile.js";
export type {
  AvatarKind,
  AvatarMetaV1,
  CustomAttributeV1,
  DirectorySyncStatus,
  DirectorySyncedField,
  LocalOnlyField,
  ProfileProvenance,
  ProfileStatus,
  SelfEditableField,
  UserProfileErrorCode,
  UserProfileErrorV1,
  UserProfileUpdateRequestV1,
  UserProfileV1,
} from "./user-profile.js";

export {
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID,
  DIRECTORY_ATTRIBUTE_NAME_MAX,
  DIRECTORY_MAPPED_FIELDS,
  parseDirectoryAttributeMap,
} from "./directory-mapping.js";
export type { DirectoryAttributeMapV1, DirectoryMappedField } from "./directory-mapping.js";

export {
  LDAP_ADMIN_ERROR_CODES,
  LDAP_ADMIN_ERROR_SCHEMA_ID,
  LDAP_GROUP_REFRESH_MODES,
  LDAP_MAX_GROUPS,
  LDAP_PROBE_REPORT_SCHEMA_ID,
  LDAP_PROBE_REQUEST_SCHEMA_ID,
  LDAP_PROBE_STAGES,
  LDAP_PROBE_STAGE_STATUSES,
  LDAP_PUBLIC_CONFIG_SCHEMA_ID,
  LDAP_USER_RESOLUTION_MODES,
  parseLdapAdminError,
  parseLdapProbeReport,
  parseLdapProbeRequest,
  parseLdapPublicConfig,
  parseLdapUserResolutionModes,
  projectLdapProbeReady,
} from "./ldap-admin.js";
export type {
  LdapAdminErrorCode,
  LdapAdminErrorV1,
  LdapGroupRefreshMode,
  LdapProbeReportV1,
  LdapProbeRequestV1,
  LdapProbeStageId,
  LdapProbeStageStatus,
  LdapProbeStageV1,
  LdapPublicConfigV1,
  LdapUserResolutionMode,
} from "./ldap-admin.js";

export {
  BROWSER_MUTATION_METHODS,
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  CSRF_ERROR_SCHEMA_ID,
  apiPathname,
  isBrowserMutationMethod,
  isCollabApiPath,
  isCsrfExemptApiPath,
  parseCsrfError,
  requiresBrowserMutationCsrf,
} from "./csrf.js";
export type { BrowserMutationMethod, CsrfErrorCode, CsrfErrorV1 } from "./csrf.js";

export {
  ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
  ADMIN_DIRECTORY_MAPPING_PREVIEW_RESPONSE_SCHEMA_ID,
  ADMIN_PEOPLE_CSRF_HEADER,
  ADMIN_PEOPLE_CSRF_HEADER_VALUE,
  ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
  ADMIN_PEOPLE_ERROR_SCHEMA_ID,
  ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_SCHEMA_ID,
  ADMIN_PEOPLE_MAX_PAGE_SIZE,
  ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_SEARCH_MAX_LENGTH,
  ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  buildEffectiveCapabilityRows,
  computeDirectoryMappingPreview,
  parseAdminDirectoryMappingPreviewRequest,
  parseAdminPeopleEffective,
  parseAdminPeopleError,
  parseAdminPeopleGrantRequest,
  parseAdminPeopleListRequest,
  parseAdminPeopleListResponse,
  parseAdminPeopleRevokeRequest,
  parseAdminPeopleStatusRequest,
} from "./admin-people.js";
export type {
  AdminDirectoryMappingPreviewRequestV1,
  AdminDirectoryMappingPreviewResponseV1,
  AdminPeopleEffectiveV1,
  AdminPeopleErrorCode,
  AdminPeopleErrorV1,
  AdminPeopleGrantRequestV1,
  AdminPeopleListRequestV1,
  AdminPeopleListResponseV1,
  AdminPeopleRevokeRequestV1,
  AdminPeopleStatusRequestV1,
  EffectiveCapabilityV1,
  LocalCapabilityGrantV1,
} from "./admin-people.js";
