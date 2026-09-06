/**
 * Browser-safe contract surface for the Source Catalog.
 *
 * Keep this entry deliberately narrow. In particular, it must not re-export
 * the package root because that graph contains server-only hashing helpers.
 */
export { ContractViolation } from "./parse.js";

export {
  SOURCE_KINDS,
  SOURCE_LIFECYCLES,
  SOURCE_SCHEMA_ID,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_MUTATION_ACTIONS,
  SOURCE_MUTATION_REFUSALS,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_DESCRIPTION_MAX_LENGTH,
  SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH,
  SOURCE_UUID_RE,
  SOURCE_IDEMPOTENCY_KEY_RE,
  SOURCE_CATALOG_ACTION_AUTHORITY,
  SOURCE_CATALOG_IDEMPOTENCY,
  SOURCE_CATALOG_RESPONSE_CONTEXT,
  parseSource,
  parseSourceList,
  parseSourceCreateRequest,
  parseSourceRetireRequest,
  parseSourceRestoreRequest,
  parseSourceMutationSuccess,
  parseSourceMutationRefused,
} from "./source.js";
export type {
  SourceKind,
  SourceLifecycle,
  SourceMutationAction,
  SourceMutationRefusal,
  SourceV1,
  SourceListV1,
  SourceCreateRequestV1,
  SourceRetireRequestV1,
  SourceRestoreRequestV1,
  SourceMutationSuccessV1,
  SourceMutationRefusedV1,
} from "./source.js";
