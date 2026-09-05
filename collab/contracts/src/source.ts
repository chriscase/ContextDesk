import type { Capability } from "./capability.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { isIsoInstant } from "./temporal.js";
import { hasDangerousUnicode } from "./user-profile.js";

export const SOURCE_KINDS = [
  "human",
  "external-tool",
  "internal-system",
  "contextdesk",
  "unknown",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LIFECYCLES = ["active", "retired"] as const;
export type SourceLifecycle = (typeof SOURCE_LIFECYCLES)[number];

export const SOURCE_SCHEMA_ID = "cd-collab.source.v1" as const;
export const SOURCE_LIST_SCHEMA_ID = "cd-collab.source_list.v1" as const;
export const SOURCE_CREATE_REQUEST_SCHEMA_ID = "cd-collab.source_create_request.v1" as const;
export const SOURCE_RETIRE_REQUEST_SCHEMA_ID = "cd-collab.source_retire_request.v1" as const;
export const SOURCE_RESTORE_REQUEST_SCHEMA_ID = "cd-collab.source_restore_request.v1" as const;
export const SOURCE_MUTATION_SUCCESS_SCHEMA_ID = "cd-collab.source_mutation_success.v1" as const;
export const SOURCE_MUTATION_REFUSED_SCHEMA_ID = "cd-collab.source_mutation_refused.v1" as const;

export const PERMANENT_UNKNOWN_SOURCE_ID = "00000000-0000-0000-0000-000000000001";

export const SOURCE_MUTATION_ACTIONS = ["create", "retire", "restore"] as const;
export type SourceMutationAction = (typeof SOURCE_MUTATION_ACTIONS)[number];

export const SOURCE_MUTATION_REFUSALS = [
  "source_not_found",
  "already_retired",
  "not_retired",
  "permanent_unknown_protected",
  "expected_revision_mismatch",
  "source_revision_unavailable",
  "identity_already_bound",
  "idempotency_intent_mismatch",
] as const;
export type SourceMutationRefusal = (typeof SOURCE_MUTATION_REFUSALS)[number];

export const SOURCE_NAME_MAX_LENGTH = 200;
export const SOURCE_DESCRIPTION_MAX_LENGTH = 400;
export const SOURCE_IDENTITY_MAX_LENGTH = 512;
export const SOURCE_REFUSAL_DETAIL_MAX_LENGTH = 600;
export const SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Lower-case UUID including the seeded permanent unknown id (version nibble 0). */
export const SOURCE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SOURCE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Catalog mutation authority is the dedicated `catalog:write` capability.
 * `run:strategies`, `admin:users`, `investigation:read`, `investigation:write`,
 * and admin-role checks are not catalog mutation authority.
 */
export const SOURCE_CATALOG_ACTION_AUTHORITY: Readonly<
  Record<SourceMutationAction, Capability>
> = Object.freeze({
  create: "catalog:write",
  retire: "catalog:write",
  restore: "catalog:write",
});

/**
 * Durable replay rules the future catalog CAS implementation must preserve.
 * Lookup is actor identity plus idempotency key; action belongs to intent, so
 * key reuse across actions is an intent mismatch. expectedRevision is excluded
 * from intent (CAS-replay), but an uncertain-outcome retry must resend the
 * exact original payload and idempotency key.
 */
export const SOURCE_CATALOG_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze(["actorIdentityId", "idempotencyKey"] as const),
  intentFields: Object.freeze({
    create: Object.freeze(["action", "name", "kind", "description", "identityId"] as const),
    retire: Object.freeze(["action", "sourceId"] as const),
    restore: Object.freeze(["action", "sourceId"] as const),
  }),
  excludesFromIntent: Object.freeze(["expectedRevision"] as const),
  beforeLookup: Object.freeze(["authorization", "active_profile"] as const),
  replayBefore: Object.freeze([
    "source_lookup",
    "permanent_unknown",
    "lifecycle",
    "identity_uniqueness",
    "cas",
  ] as const),
  persist: "successful_actions_only" as const,
  replay: "original_applied_success_and_revision_tuple" as const,
  uncertainOutcome: "freeze_exact_payload_and_idempotency_key_before_retry" as const,
});

/**
 * Server-only invariants the standalone parsers cannot prove from a wire body.
 * Authenticated actor identity is never accepted from the client.
 */
export const SOURCE_CATALOG_RESPONSE_CONTEXT = Object.freeze({
  actor: "authenticated_actor_is_server_bound_and_never_accepted_from_the_wire",
  cas: "request_expectedRevision_must_equal_current_revision_before_apply",
  idempotency: "same_key_and_intent_replays_applied_success_different_intent_refuses",
  immutableKind: "source_kind_is_immutable_after_create",
  historicalRefs: "retired_sources_remain_resolvable_for_historical_references",
  identityUniqueness: "non_null_identityId_is_unique_across_the_catalog",
  identityCollision:
    "identity_already_bound_current_identity_matches_create_request_identity",
  revisionAvailability:
    "legacy_unversioned_rows_are_read_only_until_the_server_emits_a_revision",
  replay:
    "replayed_success_returns_the_original_applied_result_and_revision_tuple",
  projection: "list_projection_is_authorization_filtered_and_not_caller_authoritative",
  auth: "mutations_require_server_authorized_catalog_write",
  audit: "successful_mutations_are_appended_to_the_audit_log",
} as const);

export interface SourceV1 {
  schemaId: typeof SOURCE_SCHEMA_ID;
  id: string;
  name: string;
  kind: SourceKind;
  description: string | null;
  lifecycle: SourceLifecycle;
  identityId: string | null;
  createdAt: string;
  createdBy: string;
  /** Present on mutation-applied rows; absent on legacy catalog rows. */
  revision?: number;
}

export interface SourceListV1 {
  schemaId: typeof SOURCE_LIST_SCHEMA_ID;
  sources: SourceV1[];
}

export interface SourceCreateRequestV1 {
  schemaId: typeof SOURCE_CREATE_REQUEST_SCHEMA_ID;
  name: string;
  kind: SourceKind;
  description: string | null;
  identityId: string | null;
  expectedRevision: 0;
  idempotencyKey: string;
}

export interface SourceRetireRequestV1 {
  schemaId: typeof SOURCE_RETIRE_REQUEST_SCHEMA_ID;
  sourceId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface SourceRestoreRequestV1 {
  schemaId: typeof SOURCE_RESTORE_REQUEST_SCHEMA_ID;
  sourceId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface SourceMutationSuccessV1 {
  schemaId: typeof SOURCE_MUTATION_SUCCESS_SCHEMA_ID;
  action: SourceMutationAction;
  sourceId: string;
  expectedRevision: number;
  previousRevision: number;
  appliedRevision: number;
  replayed: boolean;
  applied: SourceV1 & { revision: number };
}

export interface SourceMutationRefusedV1 {
  schemaId: typeof SOURCE_MUTATION_REFUSED_SCHEMA_ID;
  error: "source_catalog_refused";
  action: SourceMutationAction;
  sourceId: string | null;
  expectedRevision: number;
  reason: SourceMutationRefusal;
  detail: string;
  current: SourceV1 | null;
}

const sourceShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_SCHEMA_ID)),
  id: f.req(f.str),
  name: f.req(f.str),
  kind: f.req(f.en(...SOURCE_KINDS)),
  description: f.nul(f.str),
  lifecycle: f.req(f.en(...SOURCE_LIFECYCLES)),
  identityId: f.nul(f.str),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  revision: f.opt(f.u64),
};

const sourceListShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_LIST_SCHEMA_ID)),
  sources: f.req(f.arr(f.obj(sourceShape))),
};

const createRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_CREATE_REQUEST_SCHEMA_ID)),
  name: f.req(f.str),
  kind: f.req(f.en(...SOURCE_KINDS)),
  description: f.nul(f.str),
  identityId: f.nul(f.str),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const retireRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_RETIRE_REQUEST_SCHEMA_ID)),
  sourceId: f.req(f.str),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const restoreRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_RESTORE_REQUEST_SCHEMA_ID)),
  sourceId: f.req(f.str),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const mutationSuccessShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_MUTATION_SUCCESS_SCHEMA_ID)),
  action: f.req(f.en(...SOURCE_MUTATION_ACTIONS)),
  sourceId: f.req(f.str),
  expectedRevision: f.req(f.u64),
  previousRevision: f.req(f.u64),
  appliedRevision: f.req(f.u64),
  replayed: f.req(f.bool),
  applied: f.req(f.obj(sourceShape)),
};

const mutationRefusedShape: ObjectShape = {
  schemaId: f.req(f.en(SOURCE_MUTATION_REFUSED_SCHEMA_ID)),
  error: f.req(f.en("source_catalog_refused")),
  action: f.req(f.en(...SOURCE_MUTATION_ACTIONS)),
  sourceId: f.nul(f.str),
  expectedRevision: f.req(f.u64),
  reason: f.req(f.en(...SOURCE_MUTATION_REFUSALS)),
  detail: f.req(f.nstr),
  current: f.nul(f.obj(sourceShape)),
};

const REFUSAL_ACTIONS: Readonly<
  Record<SourceMutationRefusal, readonly SourceMutationAction[]>
> = {
  source_not_found: ["retire", "restore"],
  already_retired: ["retire"],
  not_retired: ["restore"],
  permanent_unknown_protected: ["retire", "restore"],
  expected_revision_mismatch: ["retire", "restore"],
  source_revision_unavailable: ["retire", "restore"],
  identity_already_bound: ["create"],
  idempotency_intent_mismatch: SOURCE_MUTATION_ACTIONS,
};

function recordAt(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

function hasLineBreak(value: string): boolean {
  // Matching line breaks is the point: stored catalog text stays single-line.
  return /[\n\r\u2028\u2029]/.test(value);
}

function assertSafeCatalogText(value: string, path: string): void {
  if (hasDangerousUnicode(value) || hasLineBreak(value)) {
    throw new ContractViolation(
      path,
      "control characters, bidi overrides, and multi-line text are not allowed",
    );
  }
}

function exactSafeText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if (value.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if (value.length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeCatalogText(value, path);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if (normalized !== value) {
    throw new ContractViolation(
      path,
      "must already be NFKC-normalized and contain no surrounding whitespace",
    );
  }
  return value;
}

function normalizeCatalogText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if (value.length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeCatalogText(value, path);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if (normalized.length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} normalized characters`);
  }
  assertSafeCatalogText(normalized, path);
  return normalized;
}

function requireUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !SOURCE_UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected a lower-case UUID");
  }
  return value;
}

function requireIdempotencyKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !SOURCE_IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ContractViolation(
      path,
      `must be ${SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH}..${SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH} safe characters`,
    );
  }
  return value;
}

function requireRevisionAtLeastOne(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractViolation(path, "expected a safe integer >= 1");
  }
  return value;
}

function optionalRevision(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return requireRevisionAtLeastOne(value, path);
}

function exactName(value: unknown, path: string): string {
  return exactSafeText(value, path, SOURCE_NAME_MAX_LENGTH);
}

function exactDescription(value: unknown, path: string): string | null {
  return value === null ? null : exactSafeText(value, path, SOURCE_DESCRIPTION_MAX_LENGTH);
}

function exactIdentity(value: unknown, path: string): string | null {
  return value === null ? null : exactSafeText(value, path, SOURCE_IDENTITY_MAX_LENGTH);
}

function assertPermanentUnknownConstraints(source: SourceV1, path: string): void {
  if (source.id !== PERMANENT_UNKNOWN_SOURCE_ID) return;
  if (source.kind !== "unknown") {
    throw new ContractViolation(`${path}.kind`, "permanent unknown source must have kind unknown");
  }
  if (source.lifecycle !== "active") {
    throw new ContractViolation(
      `${path}.lifecycle`,
      "permanent unknown source must remain active",
    );
  }
  if (source.identityId !== null) {
    throw new ContractViolation(
      `${path}.identityId`,
      "permanent unknown source must not bind an identity",
    );
  }
}

export function parseSource(raw: unknown, path = "$"): SourceV1 {
  checkObject(path, sourceShape, raw);
  const record = recordAt(raw, path);
  const parsed = raw as SourceV1;
  requireUuid(parsed.id, `${path}.id`);
  exactName(parsed.name, `${path}.name`);
  exactDescription(parsed.description, `${path}.description`);
  exactIdentity(parsed.identityId, `${path}.identityId`);
  exactSafeText(parsed.createdBy, `${path}.createdBy`, SOURCE_IDENTITY_MAX_LENGTH);
  if (!isIsoInstant(parsed.createdAt)) {
    throw new ContractViolation(`${path}.createdAt`, "expected an ISO-8601 instant");
  }
  const revision = optionalRevision(record.revision, `${path}.revision`);
  if (revision !== undefined) parsed.revision = revision;
  assertPermanentUnknownConstraints(parsed, path);
  return parsed;
}

export function parseSourceList(raw: unknown): SourceListV1 {
  checkObject("$", sourceListShape, raw);
  const parsed = raw as SourceListV1;
  const seenIds = new Set<string>();
  const seenIdentityIds = new Set<string>();
  parsed.sources.forEach((source, index) => {
    const parsedSource = parseSource(source, `$.sources[${index}]`);
    if (seenIds.has(parsedSource.id)) {
      throw new ContractViolation(`$.sources[${index}].id`, "duplicate source id");
    }
    seenIds.add(parsedSource.id);
    if (parsedSource.identityId !== null) {
      if (seenIdentityIds.has(parsedSource.identityId)) {
        throw new ContractViolation(
          `$.sources[${index}].identityId`,
          "duplicate bound identity",
        );
      }
      seenIdentityIds.add(parsedSource.identityId);
    }
  });
  return parsed;
}

export function parseSourceCreateRequest(raw: unknown): SourceCreateRequestV1 {
  checkObject("$", createRequestShape, raw);
  const record = recordAt(raw, "$");
  if (record.expectedRevision !== 0) {
    throw new ContractViolation("$.expectedRevision", "create expectedRevision must be 0");
  }
  return {
    schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
    name: normalizeCatalogText(record.name, "$.name", SOURCE_NAME_MAX_LENGTH),
    kind: record.kind as SourceKind,
    description:
      record.description === null
        ? null
        : normalizeCatalogText(record.description, "$.description", SOURCE_DESCRIPTION_MAX_LENGTH),
    identityId: exactIdentity(record.identityId, "$.identityId"),
    expectedRevision: 0,
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey, "$.idempotencyKey"),
  };
}

function parseExpectedRevisionAtLeastOne(value: unknown, path: string): number {
  return requireRevisionAtLeastOne(value, path);
}

export function parseSourceRetireRequest(raw: unknown): SourceRetireRequestV1 {
  checkObject("$", retireRequestShape, raw);
  const record = recordAt(raw, "$");
  return {
    schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
    sourceId: requireUuid(record.sourceId, "$.sourceId"),
    expectedRevision: parseExpectedRevisionAtLeastOne(record.expectedRevision, "$.expectedRevision"),
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey, "$.idempotencyKey"),
  };
}

export function parseSourceRestoreRequest(raw: unknown): SourceRestoreRequestV1 {
  checkObject("$", restoreRequestShape, raw);
  const record = recordAt(raw, "$");
  return {
    schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
    sourceId: requireUuid(record.sourceId, "$.sourceId"),
    expectedRevision: parseExpectedRevisionAtLeastOne(record.expectedRevision, "$.expectedRevision"),
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey, "$.idempotencyKey"),
  };
}

function parseAppliedSource(raw: unknown, path: string): SourceV1 & { revision: number } {
  const applied = parseSource(raw, path);
  if (applied.revision === undefined) {
    throw new ContractViolation(`${path}.revision`, "applied source revision is required");
  }
  return applied as SourceV1 & { revision: number };
}

function assertNotPermanentUnknownMutation(sourceId: string): void {
  if (sourceId === PERMANENT_UNKNOWN_SOURCE_ID) {
    throw new ContractViolation(
      "$.sourceId",
      "permanent unknown source cannot be created, retired, or restored",
    );
  }
}

export function parseSourceMutationSuccess(raw: unknown): SourceMutationSuccessV1 {
  checkObject("$", mutationSuccessShape, raw);
  const record = recordAt(raw, "$");
  const action = record.action as SourceMutationAction;
  const sourceId = requireUuid(record.sourceId, "$.sourceId");
  const expectedRevision = record.expectedRevision as number;
  const previousRevision = record.previousRevision as number;
  const appliedRevision = requireRevisionAtLeastOne(record.appliedRevision, "$.appliedRevision");
  const replayed = record.replayed === true;
  const applied = parseAppliedSource(record.applied, "$.applied");

  assertNotPermanentUnknownMutation(sourceId);
  if (applied.id !== sourceId) {
    throw new ContractViolation("$.applied.id", "must match sourceId");
  }
  if (applied.revision !== appliedRevision) {
    throw new ContractViolation("$.applied.revision", "must equal appliedRevision");
  }

  if (action === "create") {
    if (expectedRevision !== 0) {
      throw new ContractViolation("$.expectedRevision", "create expectedRevision must be 0");
    }
    if (previousRevision !== 0) {
      throw new ContractViolation("$.previousRevision", "create previousRevision must be 0");
    }
    if (appliedRevision !== 1) {
      throw new ContractViolation("$.appliedRevision", "create appliedRevision must be 1");
    }
    if (applied.lifecycle !== "active") {
      throw new ContractViolation("$.applied.lifecycle", "create must apply an active source");
    }
  } else if (expectedRevision < 1) {
    throw new ContractViolation("$.expectedRevision", "expected a safe integer >= 1");
  } else if (previousRevision < 1) {
    throw new ContractViolation("$.previousRevision", "expected a safe integer >= 1");
  }

  if (action === "retire" && applied.lifecycle !== "retired") {
    throw new ContractViolation("$.applied.lifecycle", "retire must apply a retired source");
  }
  if (action === "restore" && applied.lifecycle !== "active") {
    throw new ContractViolation("$.applied.lifecycle", "restore must apply an active source");
  }

  if (action !== "create") {
    if (expectedRevision !== previousRevision) {
      throw new ContractViolation(
        "$.expectedRevision",
        "must equal previousRevision for the original applied result",
      );
    }
    if (appliedRevision !== previousRevision + 1 || !Number.isSafeInteger(previousRevision + 1)) {
      throw new ContractViolation("$.appliedRevision", "must be exactly previousRevision + 1");
    }
  }

  return {
    schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
    action,
    sourceId,
    expectedRevision,
    previousRevision,
    appliedRevision,
    replayed,
    applied,
  };
}

function isPermanentUnknownRow(source: SourceV1 | null, sourceId: string | null): boolean {
  return (
    sourceId === PERMANENT_UNKNOWN_SOURCE_ID || source?.id === PERMANENT_UNKNOWN_SOURCE_ID
  );
}

export function parseSourceMutationRefused(raw: unknown): SourceMutationRefusedV1 {
  checkObject("$", mutationRefusedShape, raw);
  const record = recordAt(raw, "$");
  const action = record.action as SourceMutationAction;
  const sourceId =
    record.sourceId === null ? null : requireUuid(record.sourceId, "$.sourceId");
  const expectedRevision = record.expectedRevision as number;
  const reason = record.reason as SourceMutationRefusal;
  const current =
    record.current === null ? null : parseSource(record.current, "$.current");
  const detail = normalizeCatalogText(
    record.detail,
    "$.detail",
    SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  );

  if (!REFUSAL_ACTIONS[reason].includes(action)) {
    throw new ContractViolation("$.reason", `${reason} cannot refuse ${action}`);
  }

  if (action === "create") {
    if (expectedRevision !== 0) {
      throw new ContractViolation("$.expectedRevision", "create expectedRevision must be 0");
    }
  } else if (expectedRevision < 1) {
    throw new ContractViolation("$.expectedRevision", "expected a safe integer >= 1");
  }

  if (action === "create") {
    if (sourceId === null && current !== null) {
      throw new ContractViolation("$.sourceId", "must match current.id when current is present");
    }
  } else if (sourceId === null) {
    throw new ContractViolation("$.sourceId", "expected a lower-case UUID");
  }

  if (current !== null) {
    if (sourceId === null || current.id !== sourceId) {
      throw new ContractViolation("$.current.id", "must match sourceId");
    }
  }

  const permanentUnknown = isPermanentUnknownRow(current, sourceId);
  if (permanentUnknown) {
    if (reason !== "permanent_unknown_protected" && reason !== "idempotency_intent_mismatch") {
      throw new ContractViolation(
        "$.reason",
        "permanent unknown source must refuse as permanent_unknown_protected",
      );
    }
  }

  if (reason === "source_not_found") {
    if (current !== null) {
      throw new ContractViolation("$.current", "source_not_found requires current to be null");
    }
    if (sourceId === PERMANENT_UNKNOWN_SOURCE_ID) {
      throw new ContractViolation(
        "$.sourceId",
        "permanent unknown source is always present",
      );
    }
  }

  if (reason === "already_retired") {
    if (current === null || current.lifecycle !== "retired") {
      throw new ContractViolation("$.current.lifecycle", "already_retired requires a retired current source");
    }
  }

  if (reason === "not_retired") {
    if (current === null || current.lifecycle !== "active") {
      throw new ContractViolation("$.current.lifecycle", "not_retired requires an active current source");
    }
  }

  if (reason === "permanent_unknown_protected") {
    if (sourceId !== PERMANENT_UNKNOWN_SOURCE_ID || current === null) {
      throw new ContractViolation(
        "$.current",
        "permanent_unknown_protected requires the permanent unknown source",
      );
    }
  }

  if (reason === "expected_revision_mismatch") {
    if (current === null) {
      throw new ContractViolation("$.current", "expected_revision_mismatch requires current");
    }
    if (current.revision === undefined) {
      throw new ContractViolation(
        "$.current.revision",
        "expected_revision_mismatch requires a versioned current source",
      );
    }
    if (current.revision === expectedRevision) {
      throw new ContractViolation(
        "$.current.revision",
        "expected_revision_mismatch requires current.revision to differ",
      );
    }
  }

  if (reason === "source_revision_unavailable") {
    if (current === null) {
      throw new ContractViolation("$.current", "source_revision_unavailable requires current");
    }
    if (current.revision !== undefined) {
      throw new ContractViolation(
        "$.current.revision",
        "source_revision_unavailable requires an unversioned current source",
      );
    }
  }

  if (reason === "identity_already_bound") {
    if (current === null || current.identityId === null) {
      throw new ContractViolation(
        "$.current.identityId",
        "identity_already_bound requires a current source with a bound identity",
      );
    }
  }

  return {
    schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
    error: "source_catalog_refused",
    action,
    sourceId,
    expectedRevision,
    reason,
    detail,
    current,
  };
}
