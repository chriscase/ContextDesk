/**
 * Browser-safe contracts for one recorded file-server reference observation.
 *
 * Route identities remain authoritative. The reference identity supplied by a
 * caller is only an optimistic precondition: a server must load and observe
 * its own reference and must never use the caller's URI as a fetch target.
 * V1 records bounded reachability metadata; it does not claim that referenced
 * bytes were fetched, hashed, cached, or verified.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { isIsoInstant } from "./temporal.js";
import { hasDangerousUnicode } from "./user-profile.js";

export const REFERENCE_RECHECK_REQUEST_SCHEMA_ID =
  "cd-collab.reference_recheck_request.v1" as const;
export const REFERENCE_RECHECK_SCHEMA_ID =
  "cd-collab.reference_recheck.v1" as const;
export const REFERENCE_RECHECK_SUCCESS_SCHEMA_ID =
  "cd-collab.reference_recheck_success.v1" as const;
export const REFERENCE_RECHECK_PAGE_SCHEMA_ID =
  "cd-collab.reference_recheck_page.v1" as const;
export const REFERENCE_RECHECK_CHANGED_SCHEMA_ID =
  "cd-collab.reference_recheck_changed.v1" as const;
export const REFERENCE_RECHECK_REFUSED_SCHEMA_ID =
  "cd-collab.reference_recheck_refused.v1" as const;

export const REFERENCE_RECHECK_OUTCOMES = Object.freeze([
  "reachable_metadata",
  "unreachable",
] as const);
export type ReferenceRecheckOutcome =
  (typeof REFERENCE_RECHECK_OUTCOMES)[number];

export const REFERENCE_RECHECK_CHANGE_REASONS = Object.freeze([
  "reference_identity_changed",
  "idempotency_intent_mismatch",
] as const);
export type ReferenceRecheckChangeReason =
  (typeof REFERENCE_RECHECK_CHANGE_REASONS)[number];

export const REFERENCE_RECHECK_REFUSALS = Object.freeze([
  "investigation_archived",
  "observation_unsupported",
] as const);
export type ReferenceRecheckRefusal =
  (typeof REFERENCE_RECHECK_REFUSALS)[number];

export const REFERENCE_RECHECK_LIMITS = Object.freeze({
  idempotencyKeyMinChars: 8,
  idempotencyKeyMaxChars: 128,
  uriMaxChars: 4_096,
  detailMaxChars: 600,
  pageMaxItems: 100,
  cursorMinChars: 8,
  cursorMaxChars: 4_096,
} as const);

export interface ReferenceIdentityV1 {
  readonly kind: "file_server_ref";
  /** Compare-only recorded identity. A server must not fetch this caller value. */
  readonly uri: string;
  readonly expectedHash: string | null;
}

export interface ReferenceRecheckRequestV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_REQUEST_SCHEMA_ID;
  /** Must equal the authoritative route case identity. */
  readonly caseId: string;
  /** Must equal the authoritative route artifact identity. */
  readonly artifactId: string;
  /** Compare-only precondition, never an observation target. */
  readonly expectedReference: ReferenceIdentityV1;
  readonly idempotencyKey: string;
  /** Display-only caller clock. Audit and observation clocks stay server-owned. */
  readonly clientTime?: string;
}

export interface ReferenceRecheckV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_SCHEMA_ID;
  readonly id: string;
  readonly caseId: string;
  readonly artifactId: string;
  readonly outcome: ReferenceRecheckOutcome;
  readonly reference: ReferenceIdentityV1;
  readonly observedAt: string;
}

export interface ReferenceRecheckSuccessV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_SUCCESS_SCHEMA_ID;
  readonly caseId: string;
  readonly artifactId: string;
  /** No replay marker: a committed retry can return the exact stored success. */
  readonly applied: ReferenceRecheckV1;
}

export interface ReferenceRecheckPageV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_PAGE_SCHEMA_ID;
  readonly caseId: string;
  readonly artifactId: string;
  readonly items: readonly ReferenceRecheckV1[];
  readonly nextCursor: string | null;
}

export interface ReferenceRecheckChangedV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_CHANGED_SCHEMA_ID;
  readonly error: "reference_recheck_changed";
  readonly caseId: string;
  readonly artifactId: string;
  readonly reason: ReferenceRecheckChangeReason;
  readonly currentReference: ReferenceIdentityV1;
}

export interface ReferenceRecheckRefusedV1 {
  readonly schemaId: typeof REFERENCE_RECHECK_REFUSED_SCHEMA_ID;
  readonly error: "reference_recheck_refused";
  readonly caseId: string;
  readonly artifactId: string;
  readonly reason: ReferenceRecheckRefusal;
  readonly detail: string;
  readonly currentReference: ReferenceIdentityV1;
}

/** Server and Runtime obligations that cannot be proven by a wire parser. */
export const REFERENCE_RECHECK_RESPONSE_CONTEXT = Object.freeze({
  routeIdentity:
    "request_and_response_case_and_artifact_equal_authoritative_route_identities",
  observationTarget:
    "server_loaded_reference_only_and_request_reference_is_compare_only",
  authorization:
    "post_requires_write_and_reads_require_read_with_private_artifact_concealment",
  successIdentity:
    "applied_reference_equals_request_precondition_and_server_revalidated_reference",
  changedIdentity:
    "current_reference_is_server_loaded_and_never_a_second_lookup_target",
} as const);

/** Durable replay and ambiguous-outcome rules reserved for server and Runtime. */
export const REFERENCE_RECHECK_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze([
    "authenticatedActorIdentityId",
    "caseId",
    "artifactId",
    "idempotencyKey",
  ] as const),
  intentFields: Object.freeze([
    "caseId",
    "artifactId",
    "expectedReference",
    "idempotencyKey",
    "clientTime",
  ] as const),
  replayBefore: Object.freeze(["archive", "observation", "reference_cas"] as const),
  persist: "result_timeline_audit_and_exact_success_intent_in_one_transaction" as const,
  uncertainOutcome:
    "freeze_exact_request_then_get_reconciliation_before_manual_replay" as const,
  automaticPostRetry: false as const,
} as const);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{8,4096}$/;

const referenceShape: ObjectShape = {
  kind: f.req(f.en("file_server_ref")),
  uri: f.req(f.nstr),
  expectedHash: f.nul(f.str),
};

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_REQUEST_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  expectedReference: f.req(f.str),
  idempotencyKey: f.req(f.nstr),
  clientTime: f.opt(f.nstr),
};

const recheckShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_SCHEMA_ID)),
  id: f.req(f.nstr),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  outcome: f.req(f.en(...REFERENCE_RECHECK_OUTCOMES)),
  reference: f.req(f.str),
  observedAt: f.req(f.nstr),
};

const successShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_SUCCESS_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  applied: f.req(f.str),
};

const pageShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_PAGE_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  items: f.req(f.arr(f.obj({}))),
  nextCursor: f.nul(f.str),
};

const changedShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_CHANGED_SCHEMA_ID)),
  error: f.req(f.en("reference_recheck_changed")),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  reason: f.req(f.en(...REFERENCE_RECHECK_CHANGE_REASONS)),
  currentReference: f.req(f.str),
};

const refusedShape: ObjectShape = {
  schemaId: f.req(f.en(REFERENCE_RECHECK_REFUSED_SCHEMA_ID)),
  error: f.req(f.en("reference_recheck_refused")),
  caseId: f.req(f.nstr),
  artifactId: f.req(f.nstr),
  reason: f.req(f.en(...REFERENCE_RECHECK_REFUSALS)),
  detail: f.req(f.nstr),
  currentReference: f.req(f.str),
};

function plainRecord(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

/**
 * Reject values that are not representable as inert JSON-like contract data.
 * Descriptor traversal is deliberate: validation must not invoke caller-owned
 * accessors before deciding whether a value is safe to inspect.
 */
function assertPlainDataTree(
  raw: unknown,
  path: string,
  ancestors = new Set<object>(),
): void {
  if (typeof raw !== "object" || raw === null) return;

  const object = raw as object;
  if (ancestors.has(object)) {
    throw new ContractViolation(path, "cyclic values are not valid contract data");
  }

  const array = Array.isArray(raw);
  const prototype = Object.getPrototypeOf(object);
  if (
    (array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new ContractViolation(path, "expected plain data with no inherited properties");
  }

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw new ContractViolation(path, "symbol keys are not valid contract data");
  }

  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (array) {
    if (raw.length > REFERENCE_RECHECK_LIMITS.pageMaxItems) {
      throw new ContractViolation(
        path,
        `expected at most ${REFERENCE_RECHECK_LIMITS.pageMaxItems} items`,
      );
    }
    for (let index = 0; index < raw.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
        throw new ContractViolation(
          `${path}[${index}]`,
          "sparse arrays are not valid contract data",
        );
      }
    }
    for (const key of Object.keys(descriptors)) {
      if (key === "length") continue;
      const index = Number(key);
      if (
        !/^(0|[1-9][0-9]*)$/.test(key)
        || !Number.isSafeInteger(index)
        || index >= raw.length
      ) {
        throw new ContractViolation(`${path}.${key}`, "unknown array key (contract drift)");
      }
    }
  }

  ancestors.add(object);
  try {
    for (const key of Object.keys(descriptors)) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key]!;
      const fieldPath = array ? `${path}[${key}]` : `${path}.${key}`;
      if (!descriptor.enumerable) {
        throw new ContractViolation(
          fieldPath,
          "non-enumerable properties are not valid contract data",
        );
      }
      if (!("value" in descriptor)) {
        throw new ContractViolation(fieldPath, "accessor properties are not valid contract data");
      }
      assertPlainDataTree(descriptor.value, fieldPath, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
}

function nestedSentinels(
  raw: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const shallow = { ...raw };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(shallow, field)) shallow[field] = "nested";
  }
  return shallow;
}

function assertDenseArray(raw: unknown, path: string): asserts raw is unknown[] {
  if (!Array.isArray(raw)) throw new ContractViolation(path, "expected array");
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      throw new ContractViolation(`${path}[${index}]`, "sparse array entries are not allowed");
    }
  }
}

function safeExactText(
  raw: string,
  path: string,
  maxChars: number,
): string {
  if (raw.length > maxChars) {
    throw new ContractViolation(path, `expected at most ${maxChars} characters`);
  }
  if (
    raw.length === 0
    || raw.normalize("NFKC").trim() !== raw
    || hasDangerousUnicode(raw)
    || raw.includes("\n")
    || raw.includes("\r")
  ) {
    throw new ContractViolation(path, "expected bounded normalized single-line text");
  }
  return raw;
}

function uuid(raw: string, path: string): string {
  if (!UUID_RE.test(raw)) {
    throw new ContractViolation(path, "expected a lowercase RFC 4122 UUID");
  }
  return raw;
}

function instant(raw: string, path: string): string {
  if (!isIsoInstant(raw)) {
    throw new ContractViolation(path, "expected an ISO-8601 instant with an explicit offset");
  }
  return raw;
}

function referenceIdentity(raw: unknown, path: string): ReferenceIdentityV1 {
  checkObject(path, referenceShape, raw);
  const record = raw as ReferenceIdentityV1;
  const uri = safeExactText(record.uri, `${path}.uri`, REFERENCE_RECHECK_LIMITS.uriMaxChars);
  if (record.expectedHash !== null && !SHA256_RE.test(record.expectedHash)) {
    throw new ContractViolation(`${path}.expectedHash`, "expected a lowercase SHA-256 digest");
  }
  return Object.freeze({
    kind: "file_server_ref" as const,
    uri,
    expectedHash: record.expectedHash,
  });
}

function recheck(raw: unknown, path: string): ReferenceRecheckV1 {
  const record = plainRecord(raw, path);
  checkObject(path, recheckShape, nestedSentinels(record, ["reference"]));
  const parsed: ReferenceRecheckV1 = {
    schemaId: REFERENCE_RECHECK_SCHEMA_ID,
    id: uuid(record.id as string, `${path}.id`),
    caseId: uuid(record.caseId as string, `${path}.caseId`),
    artifactId: uuid(record.artifactId as string, `${path}.artifactId`),
    outcome: record.outcome as ReferenceRecheckOutcome,
    reference: referenceIdentity(record.reference, `${path}.reference`),
    observedAt: instant(record.observedAt as string, `${path}.observedAt`),
  };
  return Object.freeze(parsed);
}

export function parseReferenceRecheckRequest(raw: unknown): ReferenceRecheckRequestV1 {
  assertPlainDataTree(raw, "$");
  const record = plainRecord(raw, "$");
  checkObject("$", requestShape, nestedSentinels(record, ["expectedReference"]));
  const idempotencyKey = record.idempotencyKey as string;
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new ContractViolation("$.idempotencyKey", "expected 8..128 safe characters");
  }
  const parsed: ReferenceRecheckRequestV1 = {
    schemaId: REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
    caseId: uuid(record.caseId as string, "$.caseId"),
    artifactId: uuid(record.artifactId as string, "$.artifactId"),
    expectedReference: referenceIdentity(record.expectedReference, "$.expectedReference"),
    idempotencyKey,
    ...(record.clientTime === undefined
      ? {}
      : { clientTime: instant(record.clientTime as string, "$.clientTime") }),
  };
  return Object.freeze(parsed);
}

export function parseReferenceRecheck(raw: unknown): ReferenceRecheckV1 {
  assertPlainDataTree(raw, "$");
  return recheck(raw, "$");
}

export function parseReferenceRecheckSuccess(raw: unknown): ReferenceRecheckSuccessV1 {
  assertPlainDataTree(raw, "$");
  const record = plainRecord(raw, "$");
  checkObject("$", successShape, nestedSentinels(record, ["applied"]));
  const caseId = uuid(record.caseId as string, "$.caseId");
  const artifactId = uuid(record.artifactId as string, "$.artifactId");
  const applied = recheck(record.applied, "$.applied");
  if (applied.caseId !== caseId) {
    throw new ContractViolation("$.applied.caseId", "must match root caseId");
  }
  if (applied.artifactId !== artifactId) {
    throw new ContractViolation("$.applied.artifactId", "must match root artifactId");
  }
  return Object.freeze({
    schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
    caseId,
    artifactId,
    applied,
  });
}

export function parseReferenceRecheckPage(raw: unknown): ReferenceRecheckPageV1 {
  assertPlainDataTree(raw, "$");
  const record = plainRecord(raw, "$");
  assertDenseArray(record.items, "$.items");
  if (record.items.length > REFERENCE_RECHECK_LIMITS.pageMaxItems) {
    throw new ContractViolation(
      "$.items",
      `expected at most ${REFERENCE_RECHECK_LIMITS.pageMaxItems} items`,
    );
  }
  checkObject("$", pageShape, {
    ...record,
    items: record.items.map(() => ({})),
  });
  const caseId = uuid(record.caseId as string, "$.caseId");
  const artifactId = uuid(record.artifactId as string, "$.artifactId");
  const seen = new Set<string>();
  const items = record.items.map((item, index) => {
    const parsed = recheck(item, `$.items[${index}]`);
    if (parsed.caseId !== caseId) {
      throw new ContractViolation(`$.items[${index}].caseId`, "must match root caseId");
    }
    if (parsed.artifactId !== artifactId) {
      throw new ContractViolation(
        `$.items[${index}].artifactId`,
        "must match root artifactId",
      );
    }
    if (seen.has(parsed.id)) {
      throw new ContractViolation(`$.items[${index}].id`, "duplicate result identity");
    }
    seen.add(parsed.id);
    return parsed;
  });
  const nextCursor = record.nextCursor as string | null;
  if (nextCursor !== null && !OPAQUE_CURSOR_RE.test(nextCursor)) {
    throw new ContractViolation("$.nextCursor", "expected a bounded opaque cursor");
  }
  return Object.freeze({
    schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
    caseId,
    artifactId,
    items: Object.freeze(items),
    nextCursor,
  });
}

export function parseReferenceRecheckChanged(raw: unknown): ReferenceRecheckChangedV1 {
  assertPlainDataTree(raw, "$");
  const record = plainRecord(raw, "$");
  checkObject("$", changedShape, nestedSentinels(record, ["currentReference"]));
  return Object.freeze({
    schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
    error: "reference_recheck_changed" as const,
    caseId: uuid(record.caseId as string, "$.caseId"),
    artifactId: uuid(record.artifactId as string, "$.artifactId"),
    reason: record.reason as ReferenceRecheckChangeReason,
    currentReference: referenceIdentity(record.currentReference, "$.currentReference"),
  });
}

export function parseReferenceRecheckRefused(raw: unknown): ReferenceRecheckRefusedV1 {
  assertPlainDataTree(raw, "$");
  const record = plainRecord(raw, "$");
  checkObject("$", refusedShape, nestedSentinels(record, ["currentReference"]));
  return Object.freeze({
    schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
    error: "reference_recheck_refused" as const,
    caseId: uuid(record.caseId as string, "$.caseId"),
    artifactId: uuid(record.artifactId as string, "$.artifactId"),
    reason: record.reason as ReferenceRecheckRefusal,
    detail: safeExactText(
      record.detail as string,
      "$.detail",
      REFERENCE_RECHECK_LIMITS.detailMaxChars,
    ),
    currentReference: referenceIdentity(record.currentReference, "$.currentReference"),
  });
}
