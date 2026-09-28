/**
 * Browser-safe External-run Human Judgment V1.
 *
 * Append-only human judgments about one imported external run. Parsers never
 * treat a judgment as a correctness verdict: the success run projection is a
 * pure immutable identity/provenance stub `{id, caseId, sourceId, createdAt}`
 * and never fabricates or mirrors legacy ExternalRunV1 corroboration. Empty
 * links parse for every judgment value; server policy may later refuse empty
 * `corroborates` / `contradicts` with `links_required`.
 *
 * This module must stay free of `node:*` and must not import `./run.js`.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { canonicalInstant, isIsoInstant } from "./temporal.js";
import { hasDangerousUnicode } from "./user-profile.js";

export const EXTERNAL_RUN_JUDGMENT_SCHEMA_ID =
  "cd-collab.external_run_judgment.v1" as const;
export const EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID =
  "cd-collab.external_run_judgment_request.v1" as const;
export const EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID =
  "cd-collab.external_run_judgment_success.v1" as const;
export const EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID =
  "cd-collab.external_run_judgment_refused.v1" as const;
export const EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID =
  "cd-collab.external_run_judgment_conflict.v1" as const;
export const EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID =
  "cd-collab.external_run_judgment_list.v1" as const;

export const EXTERNAL_RUN_JUDGMENT_ERROR = "external_run_judgment_refused" as const;

export const EXTERNAL_RUN_JUDGMENT_NOT_CORRECTNESS =
  "A human judgment records corroboration, contradiction, or insufficient evidence; it is not a correctness verdict." as const;

export const EXTERNAL_RUN_JUDGMENT_VALUES = Object.freeze([
  "corroborates",
  "contradicts",
  "insufficient_evidence",
] as const);
export type ExternalRunJudgmentValue = (typeof EXTERNAL_RUN_JUDGMENT_VALUES)[number];

export const EXTERNAL_RUN_JUDGMENT_LINK_KINDS = Object.freeze([
  "artifact",
  "contribution",
  "snapshot",
] as const);
export type ExternalRunJudgmentLinkKind = (typeof EXTERNAL_RUN_JUDGMENT_LINK_KINDS)[number];

export const EXTERNAL_RUN_JUDGMENT_REFUSALS = Object.freeze([
  "case_archived",
  "idempotency_intent_mismatch",
  "privacy_mismatch",
  "links_required",
] as const);
export type ExternalRunJudgmentRefusal = (typeof EXTERNAL_RUN_JUDGMENT_REFUSALS)[number];

/** Lower-case UUID, including version-nibble 0 used by seeded catalog ids. */
export const EXTERNAL_RUN_JUDGMENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY_KEY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export const EXTERNAL_RUN_JUDGMENT_LIMITS = Object.freeze({
  actorIdMaxLength: 512,
  usernameMaxLength: 200,
  rationaleMaxLength: 4000,
  refusalDetailMaxLength: 600,
  linksMax: 64,
  idempotencyKeyMinLength: 8,
  idempotencyKeyMaxLength: 128,
} as const);

/**
 * Durable-replay declarations the future route must preserve.
 * schemaId, idempotencyKey, and expectedSequence are excluded from intent.
 * idempotencyKey remains lookup-key only. expectedSequence is CAS-only so a
 * retry may refresh it. An uncertain commit must freeze the exact payload and
 * idempotency key before retry.
 */
export const EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze([
    "caseId",
    "runId",
    "authenticatedActor",
    "idempotencyKey",
  ] as const),
  intentFields: Object.freeze([
    "caseId",
    "runId",
    "judgment",
    "links",
    "rationale",
  ] as const),
  excludesFromIntent: Object.freeze([
    "schemaId",
    "idempotencyKey",
    "expectedSequence",
  ] as const),
  replay: "same_intent_replays_original_result_with_only_replayed_changed",
  mismatch: "changed_intent_refuses_idempotency_intent_mismatch",
  persist: "manual_attributed_writes_only",
  uncertainOutcome: "freeze_exact_payload_and_idempotency_key_before_retry",
  emptyLinks:
    "parser_allows_empty_links_server_may_refuse_empty_corroborates_or_contradicts",
  statuses: Object.freeze({
    fresh: 201,
    replay: 200,
    refusal: 409,
    conflict: 409,
    invalid: Object.freeze([400, 413] as const),
    auth: Object.freeze([401, 403] as const),
    concealed: 404,
    unknownCommit: 503,
    unknownCommitCode: "commit_outcome_unknown",
  }),
} as const);

/**
 * Server/gateway-owned invariants the standalone parsers cannot prove from a
 * single wire body. Parsers validate nested identities inside one envelope;
 * they do not see the route, path, request, or authenticated actor.
 */
export const EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT = Object.freeze({
  actor: "authenticated_actor_is_server_bound_and_never_accepted_from_the_wire",
  actorBinding:
    "server_or_gateway_enforces_applied_actor_equals_authenticated_actor",
  identityMatch:
    "server_or_gateway_enforces_route_path_request_and_envelope_case_and_run_identity_match",
  appliedIntent:
    "server_or_gateway_enforces_applied_intent_equals_parsed_request",
  appliedSeq:
    "server_or_gateway_enforces_applied_seq_equals_expected_sequence_plus_one_on_fresh_success",
  parserCannotProveRequestOrAuth:
    "parsers_cannot_prove_request_or_auth_facts_server_or_gateway_enforces_those_bindings",
  runProjection:
    "success_run_projection_is_an_immutable_identity_stub_id_caseId_sourceId_createdAt_and_never_mirrors_or_fabricates_legacy_corroboration",
  runProvenance:
    "server_or_gateway_enforces_success_run_sourceId_and_createdAt_exactly_equal_stored_ExternalRunV1_identified_by_run_id_and_runId",
  listRunProvenance:
    "server_or_gateway_enforces_list_runId_identifies_the_same_stored_ExternalRunV1_the_list_envelope_does_not_project_sourceId_or_createdAt",
  parserCannotProveStoredRun:
    "parsers_validate_canonical_run_sourceId_and_createdAt_structurally_and_cannot_look_up_the_stored_run",
  list: "complete_unpaged_ordered_contiguous_seq_starting_at_1_bounded_by_later_server_policy",
  links: "parser_allows_empty_links_for_every_judgment_value",
  noAutomaticWrites: "no_automatic_or_background_writes",
} as const);

export interface ExternalRunJudgmentActorV1 {
  readonly id: string;
  readonly username: string;
}

export interface ExternalRunJudgmentLinkV1 {
  readonly kind: ExternalRunJudgmentLinkKind;
  readonly id: string;
}

export interface ExternalRunJudgmentRecordV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_SCHEMA_ID;
  readonly caseId: string;
  readonly runId: string;
  readonly seq: number;
  readonly judgment: ExternalRunJudgmentValue;
  readonly actor: ExternalRunJudgmentActorV1;
  readonly links: readonly ExternalRunJudgmentLinkV1[];
  readonly rationale: string | null;
  readonly recordedAt: string;
}

export interface ExternalRunJudgmentRequestV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID;
  readonly caseId: string;
  readonly runId: string;
  readonly expectedSequence: number;
  readonly idempotencyKey: string;
  readonly judgment: ExternalRunJudgmentValue;
  readonly links: readonly ExternalRunJudgmentLinkV1[];
  readonly rationale: string | null;
}

export interface ExternalRunJudgmentRunProjectionV1 {
  readonly id: string;
  readonly caseId: string;
  readonly sourceId: string;
  readonly createdAt: string;
}

export interface ExternalRunJudgmentSuccessV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID;
  readonly caseId: string;
  readonly runId: string;
  readonly applied: ExternalRunJudgmentRecordV1;
  readonly replayed: boolean;
  readonly run: ExternalRunJudgmentRunProjectionV1;
}

export interface ExternalRunJudgmentRefusedV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID;
  readonly error: typeof EXTERNAL_RUN_JUDGMENT_ERROR;
  readonly caseId: string;
  readonly runId: string;
  readonly reason: ExternalRunJudgmentRefusal;
  readonly detail: string;
  readonly current: null;
}

export interface ExternalRunJudgmentConflictV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID;
  readonly caseId: string;
  readonly runId: string;
  readonly expectedSequence: number;
  readonly currentSequence: number;
}

export interface ExternalRunJudgmentListV1 {
  readonly schemaId: typeof EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID;
  readonly caseId: string;
  readonly runId: string;
  readonly judgments: readonly ExternalRunJudgmentRecordV1[];
}

export interface ExternalRunJudgmentIdempotencyIntentV1 {
  readonly caseId: string;
  readonly runId: string;
  readonly judgment: ExternalRunJudgmentValue;
  readonly links: readonly ExternalRunJudgmentLinkV1[];
  readonly rationale: string | null;
}

const actorShape: ObjectShape = {
  id: f.req(f.str),
  username: f.req(f.str),
};

const linkShape: ObjectShape = {
  kind: f.req(f.en(...EXTERNAL_RUN_JUDGMENT_LINK_KINDS)),
  id: f.req(f.str),
};

const recordShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_SCHEMA_ID)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  seq: f.req(f.u64),
  judgment: f.req(f.en(...EXTERNAL_RUN_JUDGMENT_VALUES)),
  actor: f.req(f.obj(actorShape)),
  links: f.req(f.arr(f.obj(linkShape))),
  rationale: f.nul(f.str),
  recordedAt: f.req(f.str),
};

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  expectedSequence: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
  judgment: f.req(f.en(...EXTERNAL_RUN_JUDGMENT_VALUES)),
  links: f.req(f.arr(f.obj(linkShape))),
  rationale: f.nul(f.str),
};

const runProjectionShape: ObjectShape = {
  id: f.req(f.str),
  caseId: f.req(f.str),
  sourceId: f.req(f.str),
  createdAt: f.req(f.str),
};

const successShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  applied: f.req(f.obj(recordShape)),
  replayed: f.req(f.bool),
  run: f.req(f.obj(runProjectionShape)),
};

const refusedShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID)),
  error: f.req(f.en(EXTERNAL_RUN_JUDGMENT_ERROR)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  reason: f.req(f.en(...EXTERNAL_RUN_JUDGMENT_REFUSALS)),
  detail: f.req(f.nstr),
  // Parse helpers have no null-only field type; non-null is rejected below.
  current: f.nul(f.str),
};

const conflictShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  expectedSequence: f.req(f.u64),
  currentSequence: f.req(f.u64),
};

const listShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  runId: f.req(f.str),
  judgments: f.req(f.arr(f.obj(recordShape))),
};

function recordAt(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

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

  const prototype = Object.getPrototypeOf(object);
  const expectedPrototype = Array.isArray(raw) ? Array.prototype : Object.prototype;
  if (prototype !== expectedPrototype && prototype !== null) {
    throw new ContractViolation(path, "expected plain data with no inherited properties");
  }

  const descriptors = Object.getOwnPropertyDescriptors(object);
  const symbols = Object.getOwnPropertySymbols(object);
  if (symbols.length > 0) {
    throw new ContractViolation(path, "symbol keys are not valid contract data");
  }
  if (Array.isArray(raw)) {
    for (let index = 0; index < raw.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
        throw new ContractViolation(
          `${path}[${index}]`,
          "sparse arrays are not valid contract data",
        );
      }
    }
    for (const key of Object.keys(descriptors)) {
      if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) {
        throw new ContractViolation(`${path}.${key}`, "unknown array key (contract drift)");
      }
    }
  }

  ancestors.add(object);
  try {
    for (const key of Object.keys(descriptors)) {
      if (key === "length" && Array.isArray(raw)) continue;
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) {
        throw new ContractViolation(
          Array.isArray(raw) ? `${path}[${key}]` : `${path}.${key}`,
          "accessor properties are not valid contract data",
        );
      }
      assertPlainDataTree(
        descriptor.value,
        Array.isArray(raw) ? `${path}[${key}]` : `${path}.${key}`,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(object);
  }
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

function hasLineBreak(value: string): boolean {
  // Matching line breaks is the point: identity labels stay single-line.
  return /[\n\r\u2028\u2029]/.test(value);
}

function assertSafeSingleLine(value: string, path: string): void {
  if (hasDangerousUnicode(value) || hasLineBreak(value)) {
    throw new ContractViolation(
      path,
      "control characters, bidi overrides, and multi-line text are not allowed",
    );
  }
}

function assertSafeMultiline(value: string, path: string): void {
  if (/[\r\u2028\u2029]/.test(value) || hasDangerousUnicode(value.replaceAll("\n", ""))) {
    throw new ContractViolation(
      path,
      "control characters, bidi overrides, and Unicode line separators are not allowed",
    );
  }
}

function exactSafeIdentityText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if (value.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if ([...value].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeSingleLine(value, path);
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
  if ([...value].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeSingleLine(value, path);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if ([...normalized].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} normalized characters`);
  }
  assertSafeSingleLine(normalized, path);
  return normalized;
}

function normalizeMultilineText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if ([...value].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeMultiline(value, path);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if ([...normalized].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} normalized characters`);
  }
  assertSafeMultiline(normalized, path);
  return normalized;
}

function nullableRationale(value: unknown, path: string): string | null {
  if (value === null) return null;
  return normalizeMultilineText(
    value,
    path,
    EXTERNAL_RUN_JUDGMENT_LIMITS.rationaleMaxLength,
  );
}

function requireUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !EXTERNAL_RUN_JUDGMENT_UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected a lower-case UUID");
  }
  return value;
}

function requireIdempotencyKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ContractViolation(
      path,
      `must be ${EXTERNAL_RUN_JUDGMENT_LIMITS.idempotencyKeyMinLength}..${EXTERNAL_RUN_JUDGMENT_LIMITS.idempotencyKeyMaxLength} safe characters`,
    );
  }
  return value;
}

function requireSeq(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractViolation(path, "expected an unsigned safe integer");
  }
  if (value < 1) {
    throw new ContractViolation(path, "expected an unsigned safe integer >= 1");
  }
  return value;
}

function requireUnsignedSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractViolation(path, "expected an unsigned safe integer");
  }
  return value;
}

function requireCanonicalUtcInstant(value: unknown, path: string): string {
  if (typeof value !== "string" || !isIsoInstant(value)) {
    throw new ContractViolation(
      path,
      "expected an ISO-8601 instant with an explicit offset",
    );
  }
  if (canonicalInstant(value) !== value) {
    throw new ContractViolation(path, "expected a canonical UTC server instant");
  }
  return value;
}

function compareLinks(left: ExternalRunJudgmentLinkV1, right: ExternalRunJudgmentLinkV1): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function parseLinks(value: unknown, path: string): ExternalRunJudgmentLinkV1[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation(path, "expected array");
  }
  if (value.length > EXTERNAL_RUN_JUDGMENT_LIMITS.linksMax) {
    throw new ContractViolation(
      path,
      `expected at most ${EXTERNAL_RUN_JUDGMENT_LIMITS.linksMax} links`,
    );
  }
  const parsed: ExternalRunJudgmentLinkV1[] = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    checkObject(itemPath, linkShape, item);
    const record = recordAt(item, itemPath);
    return {
      kind: record.kind as ExternalRunJudgmentLinkKind,
      id: requireUuid(record.id, `${itemPath}.id`),
    };
  });
  const seen = new Set<string>();
  parsed.forEach((link, index) => {
    const key = `${link.kind}:${link.id}`;
    if (seen.has(key)) {
      throw new ContractViolation(`${path}[${index}]`, "duplicate link");
    }
    seen.add(key);
  });
  const sorted = [...parsed].sort(compareLinks);
  for (let index = 0; index < parsed.length; index += 1) {
    const actual = parsed[index]!;
    const expected = sorted[index]!;
    if (actual.kind !== expected.kind || actual.id !== expected.id) {
      throw new ContractViolation(path, "must be in canonical lexical order");
    }
  }
  return parsed;
}

function parseActor(value: unknown, path: string): ExternalRunJudgmentActorV1 {
  checkObject(path, actorShape, value);
  const record = recordAt(value, path);
  return {
    id: exactSafeIdentityText(
      record.id,
      `${path}.id`,
      EXTERNAL_RUN_JUDGMENT_LIMITS.actorIdMaxLength,
    ),
    username: normalizeCatalogText(
      record.username,
      `${path}.username`,
      EXTERNAL_RUN_JUDGMENT_LIMITS.usernameMaxLength,
    ),
  };
}

function parseRecord(raw: unknown, path: string): ExternalRunJudgmentRecordV1 {
  checkObject(path, recordShape, raw);
  const record = recordAt(raw, path);
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
    caseId: requireUuid(record.caseId, `${path}.caseId`),
    runId: requireUuid(record.runId, `${path}.runId`),
    seq: requireSeq(record.seq, `${path}.seq`),
    judgment: record.judgment as ExternalRunJudgmentValue,
    actor: parseActor(record.actor, `${path}.actor`),
    links: parseLinks(record.links, `${path}.links`),
    rationale: nullableRationale(record.rationale, `${path}.rationale`),
    recordedAt: requireCanonicalUtcInstant(record.recordedAt, `${path}.recordedAt`),
  };
}

function parseRunProjection(
  raw: unknown,
  path: string,
  caseId: string,
  runId: string,
): ExternalRunJudgmentRunProjectionV1 {
  checkObject(path, runProjectionShape, raw);
  const record = recordAt(raw, path);
  const id = requireUuid(record.id, `${path}.id`);
  const projectedCaseId = requireUuid(record.caseId, `${path}.caseId`);
  if (id !== runId) {
    throw new ContractViolation(`${path}.id`, "must match runId");
  }
  if (projectedCaseId !== caseId) {
    throw new ContractViolation(`${path}.caseId`, "must match caseId");
  }
  return {
    id,
    caseId: projectedCaseId,
    sourceId: requireUuid(record.sourceId, `${path}.sourceId`),
    createdAt: requireCanonicalUtcInstant(record.createdAt, `${path}.createdAt`),
  };
}

export function parseExternalRunJudgment(raw: unknown): ExternalRunJudgmentRecordV1 {
  assertPlainDataTree(raw, "$");
  return deepFrozenCopy(parseRecord(raw, "$"));
}

export function parseExternalRunJudgmentRequest(raw: unknown): ExternalRunJudgmentRequestV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", requestShape, raw);
  const record = recordAt(raw, "$");
  return deepFrozenCopy({
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId: requireUuid(record.caseId, "$.caseId"),
    runId: requireUuid(record.runId, "$.runId"),
    expectedSequence: requireUnsignedSafeInteger(
      record.expectedSequence,
      "$.expectedSequence",
    ),
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey, "$.idempotencyKey"),
    judgment: record.judgment as ExternalRunJudgmentValue,
    links: parseLinks(record.links, "$.links"),
    rationale: nullableRationale(record.rationale, "$.rationale"),
  });
}

export function parseExternalRunJudgmentSuccess(raw: unknown): ExternalRunJudgmentSuccessV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", successShape, raw);
  const record = recordAt(raw, "$");
  const caseId = requireUuid(record.caseId, "$.caseId");
  const runId = requireUuid(record.runId, "$.runId");
  const applied = parseRecord(record.applied, "$.applied");
  if (applied.caseId !== caseId) {
    throw new ContractViolation("$.applied.caseId", "must match caseId");
  }
  if (applied.runId !== runId) {
    throw new ContractViolation("$.applied.runId", "must match runId");
  }
  const run = parseRunProjection(record.run, "$.run", caseId, runId);
  return deepFrozenCopy({
    schemaId: EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
    caseId,
    runId,
    applied,
    replayed: record.replayed === true,
    run,
  });
}

export function parseExternalRunJudgmentRefused(raw: unknown): ExternalRunJudgmentRefusedV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", refusedShape, raw);
  const record = recordAt(raw, "$");
  if (record.current !== null) {
    throw new ContractViolation("$.current", "requires current to be null");
  }
  return deepFrozenCopy({
    schemaId: EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_JUDGMENT_ERROR,
    caseId: requireUuid(record.caseId, "$.caseId"),
    runId: requireUuid(record.runId, "$.runId"),
    reason: record.reason as ExternalRunJudgmentRefusal,
    detail: normalizeCatalogText(
      record.detail,
      "$.detail",
      EXTERNAL_RUN_JUDGMENT_LIMITS.refusalDetailMaxLength,
    ),
    current: null,
  });
}

export function parseExternalRunJudgmentConflict(raw: unknown): ExternalRunJudgmentConflictV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", conflictShape, raw);
  const record = recordAt(raw, "$");
  const expectedSequence = requireUnsignedSafeInteger(
    record.expectedSequence,
    "$.expectedSequence",
  );
  const currentSequence = requireUnsignedSafeInteger(
    record.currentSequence,
    "$.currentSequence",
  );
  if (expectedSequence === currentSequence) {
    throw new ContractViolation(
      "$.currentSequence",
      "stale conflict requires currentSequence to differ from expectedSequence",
    );
  }
  return deepFrozenCopy({
    schemaId: EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID,
    caseId: requireUuid(record.caseId, "$.caseId"),
    runId: requireUuid(record.runId, "$.runId"),
    expectedSequence,
    currentSequence,
  });
}

export function parseExternalRunJudgmentList(raw: unknown): ExternalRunJudgmentListV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", listShape, raw);
  const record = recordAt(raw, "$");
  const caseId = requireUuid(record.caseId, "$.caseId");
  const runId = requireUuid(record.runId, "$.runId");
  if (!Array.isArray(record.judgments)) {
    throw new ContractViolation("$.judgments", "expected array");
  }
  const judgments = record.judgments.map((item, index) =>
    parseRecord(item, `$.judgments[${index}]`),
  );
  judgments.forEach((row, index) => {
    if (row.caseId !== caseId) {
      throw new ContractViolation(`$.judgments[${index}].caseId`, "must match caseId");
    }
    if (row.runId !== runId) {
      throw new ContractViolation(`$.judgments[${index}].runId`, "must match runId");
    }
    if (row.seq !== index + 1) {
      throw new ContractViolation(
        `$.judgments[${index}].seq`,
        "judgments must be a contiguous sequence starting at 1",
      );
    }
  });
  return deepFrozenCopy({
    schemaId: EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID,
    caseId,
    runId,
    judgments,
  });
}

/** Canonical idempotency intent: caseId, runId, judgment, links, rationale. */
export function projectExternalRunJudgmentIdempotencyIntent(
  raw: unknown,
): ExternalRunJudgmentIdempotencyIntentV1 {
  const request = parseExternalRunJudgmentRequest(raw);
  return deepFrozenCopy({
    caseId: request.caseId,
    runId: request.runId,
    judgment: request.judgment,
    links: request.links,
    rationale: request.rationale,
  });
}
