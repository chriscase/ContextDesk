import { createHash } from "node:crypto";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { parseContribution, type ContributionV1 } from "./contribution.js";
import {
  SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_RE,
  SOURCE_IDENTITY_MAX_LENGTH,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  SOURCE_UUID_RE,
  parseSource,
  type SourceKind,
  type SourceV1,
} from "./source.js";
import { isIsoInstant } from "./temporal.js";
import { hasDangerousUnicode } from "./user-profile.js";

/** Aligns with #878 completeness vocabulary. Collab copies the words only. */
export const COMPLETENESS = ["exact", "partial", "unknown"] as const;
export type Completeness = (typeof COMPLETENESS)[number];

export const EVIDENCE_VISIBILITY = ["unknown", "importer_described"] as const;
export type EvidenceVisibility = (typeof EVIDENCE_VISIBILITY)[number];

export const CORROBORATION_STATES = ["unverified", "corroborated", "contradicted"] as const;
export type CorroborationState = (typeof CORROBORATION_STATES)[number];

export const EXTERNAL_RUN_SCHEMA_ID = "cd-collab.external_run.v1" as const;
export const EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID =
  "cd-collab.external_run_import_request.v1" as const;
export const EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID =
  "cd-collab.external_run_import_success.v1" as const;
export const EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID =
  "cd-collab.external_run_import_refused.v1" as const;

export const EXTERNAL_RUN_IMPORT_MODES = ["manual"] as const;
export type ExternalRunImportMode = (typeof EXTERNAL_RUN_IMPORT_MODES)[number];

export const IMPORTABLE_SOURCE_KINDS = [
  "external-tool",
  "internal-system",
  "unknown",
] as const;
export type ImportableSourceKind = (typeof IMPORTABLE_SOURCE_KINDS)[number];

export const EXTERNAL_RUN_IMPORT_ERROR = "external_run_import_refused" as const;

export const EXTERNAL_RUN_IMPORT_REFUSALS = [
  "case_archived",
  "source_not_versioned",
  "source_retired",
  "source_revision_mismatch",
  "source_kind_not_importable",
  "privacy_mismatch",
  "idempotency_intent_mismatch",
] as const;
export type ExternalRunImportRefusal = (typeof EXTERNAL_RUN_IMPORT_REFUSALS)[number];

export const EXTERNAL_RUN_SHA256_RE = /^[a-f0-9]{64}$/;

export const EXTERNAL_RUN_IMPORT_LIMITS = {
  combinedTextMaxBytes: 1_000_000,
  evidenceArtifactIdsMax: 64,
  claimedTracesMax: 32,
  claimedTraceMaxLength: 200,
  metadataMaxLength: 200,
  visibilityNoteMaxLength: 1000,
  uncertaintyMaxLength: 4000,
  clientTimeMaxLength: 64,
  operatorIdentityMaxLength: SOURCE_IDENTITY_MAX_LENGTH,
  operatorUsernameMaxLength: SOURCE_NAME_MAX_LENGTH,
  refusalDetailMaxLength: SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  idempotencyKeyMinLength: SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH,
  idempotencyKeyMaxLength: SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH,
} as const;

/**
 * Server-only invariants the standalone parsers cannot prove from a wire body.
 * Request operator null maps to the authenticated importer for the required
 * stored operator identity fields. Any supplied request operator remains
 * descriptive only and is never authority. Authenticated actor identity is
 * never accepted from the client. Artifact/snapshot existence and privacy
 * verification are not claimed by the request parser.
 */
export const EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT = Object.freeze({
  actor: "authenticated_actor_is_server_bound_and_never_accepted_from_the_wire",
  operator:
    "request_operator_null_maps_to_authenticated_importer_for_required_stored_operator_identity_fields_and_any_supplied_operator_is_descriptive_only_and_never_authority",
  hashes: "output_and_prompt_hashes_derive_from_exact_request_bytes",
  contributionActor: "contribution_and_importer_actor_binding_is_server_owned",
  parserCannotCompare:
    "parser_cannot_compare_request_content_or_authenticated_actor",
  artifacts:
    "server_verifies_same_case_readable_artifacts_exact_snapshot_membership_and_privacy",
  source:
    "server_verifies_source_visibility_active_version_kind_and_revision",
  authorization: "import_requires_server_authorized_case_write",
  audit: "successful_imports_are_appended_to_the_audit_log",
  atomicity: "run_and_contribution_persist_atomically",
  privacy: "explicit_privacy_class_is_required_and_redacted_grants_nothing",
  concealed:
    "missing_or_concealed_case_source_artifact_or_snapshot_is_ordinary_indistinguishable_404",
  authOrder:
    "authenticate_then_permission_and_case_visibility_before_durable_replay",
  noAutomaticWrites: "no_automatic_or_background_writes",
  parserLimit:
    "request_parser_does_not_claim_artifact_snapshot_existence_or_privacy_verification",
} as const);

/** Transport and durable-replay declarations the future route must preserve. */
export const EXTERNAL_RUN_IMPORT_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze(["caseId", "authenticatedActor", "idempotencyKey"] as const),
  excludesFromIntent: Object.freeze([
    "schemaId",
    "idempotencyKey",
    "expectedSourceRevision",
    "clientTime",
  ] as const),
  replay: "same_intent_replays_original_result_with_only_replayed_changed",
  mismatch: "changed_intent_refuses_idempotency_intent_mismatch",
  persist: "manual_attributed_writes_only",
  uncertainOutcome: "freeze_exact_payload_and_idempotency_key_before_retry",
  statuses: Object.freeze({
    fresh: 201,
    replay: 200,
    refusal: 409,
    invalid: Object.freeze([400, 413] as const),
    auth: Object.freeze([401, 403] as const),
    concealed: 404,
    unknownCommit: 503,
    unknownCommitCode: "commit_outcome_unknown",
  }),
} as const);

export interface ExternalRunV1 {
  schemaId: typeof EXTERNAL_RUN_SCHEMA_ID;
  id: string;
  caseId: string;
  contributionId: string;
  sourceId: string;
  outputHash: string;
  outputText: string;
  promptHash: string | null;
  promptText: string | null;
  promptCompleteness: Completeness;
  outputCompleteness: Completeness;
  workflowCompleteness: Completeness;
  evidenceVisibility: EvidenceVisibility;
  /** Content-addressed #888 package snapshot when one exists. Null until then. */
  snapshotBinding: string | null;
  visibilityNote: string | null;
  importerId: string;
  importerUsername: string;
  operatorId: string;
  operatorUsername: string;
  provider: string | null;
  model: string | null;
  version: string | null;
  claimedTraces: string[];
  uncertainty: string | null;
  timing: string | null;
  cost: string | null;
  redacted: boolean;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  corroborationState: CorroborationState;
  createdAt: string;
  /** Present on successful manual imports; absent on legacy rows. */
  importMode?: ExternalRunImportMode;
  /** Present on successful manual imports; absent on legacy rows. */
  sourceRevision?: number;
  /** Present on successful manual imports; absent on legacy rows. */
  evidenceArtifactIds?: string[];
}

export interface ExternalRunOperatorV1 {
  identityId: string;
  username: string;
}

export interface ExternalRunImportRequestV1 {
  schemaId: typeof EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID;
  importMode: ExternalRunImportMode;
  caseId: string;
  sourceId: string;
  expectedSourceRevision: number;
  outputText: string;
  promptText: string | null;
  promptCompleteness: Completeness;
  outputCompleteness: Completeness;
  workflowCompleteness: Completeness;
  evidenceVisibility: EvidenceVisibility;
  evidenceArtifactIds: string[];
  snapshotBinding: string | null;
  visibilityNote: string | null;
  operator: ExternalRunOperatorV1 | null;
  provider: string | null;
  model: string | null;
  version: string | null;
  claimedTraces: string[];
  uncertainty: string | null;
  timing: string | null;
  cost: string | null;
  redacted: boolean;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  clientTime?: string;
}

export type AppliedImportedExternalRunV1 = ExternalRunV1 & {
  importMode: "manual";
  sourceRevision: number;
  evidenceArtifactIds: string[];
};

export interface ExternalRunImportSuccessV1 {
  schemaId: typeof EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID;
  importMode: ExternalRunImportMode;
  caseId: string;
  sourceId: string;
  expectedSourceRevision: number;
  replayed: boolean;
  applied: AppliedImportedExternalRunV1;
  contribution: ContributionV1;
}

export interface ExternalRunImportRefusedV1 {
  schemaId: typeof EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID;
  error: typeof EXTERNAL_RUN_IMPORT_ERROR;
  importMode: ExternalRunImportMode;
  caseId: string;
  sourceId: string;
  expectedSourceRevision: number;
  reason: ExternalRunImportRefusal;
  detail: string;
  current: SourceV1 | null;
}

const operatorShape: ObjectShape = {
  identityId: f.req(f.str),
  username: f.req(f.str),
};

const runShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  contributionId: f.req(f.str),
  sourceId: f.req(f.str),
  outputHash: f.req(f.str),
  outputText: f.req(f.str),
  promptHash: f.nul(f.str),
  promptText: f.nul(f.str),
  promptCompleteness: f.req(f.en(...COMPLETENESS)),
  outputCompleteness: f.req(f.en(...COMPLETENESS)),
  workflowCompleteness: f.req(f.en(...COMPLETENESS)),
  evidenceVisibility: f.req(f.en(...EVIDENCE_VISIBILITY)),
  snapshotBinding: f.nul(f.str),
  visibilityNote: f.nul(f.str),
  importerId: f.req(f.str),
  importerUsername: f.req(f.str),
  operatorId: f.req(f.str),
  operatorUsername: f.req(f.str),
  provider: f.nul(f.str),
  model: f.nul(f.str),
  version: f.nul(f.str),
  claimedTraces: f.req(f.arr(f.str)),
  uncertainty: f.nul(f.str),
  timing: f.nul(f.str),
  cost: f.nul(f.str),
  redacted: f.req(f.bool),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  corroborationState: f.req(f.en(...CORROBORATION_STATES)),
  createdAt: f.req(f.str),
  importMode: f.opt(f.en(...EXTERNAL_RUN_IMPORT_MODES)),
  sourceRevision: f.opt(f.u64),
  evidenceArtifactIds: f.opt(f.arr(f.str)),
};

const appliedRunShape: ObjectShape = {
  ...runShape,
  importMode: f.req(f.en(...EXTERNAL_RUN_IMPORT_MODES)),
  sourceRevision: f.req(f.u64),
  evidenceArtifactIds: f.req(f.arr(f.str)),
};

const importRequestShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID)),
  importMode: f.req(f.en(...EXTERNAL_RUN_IMPORT_MODES)),
  caseId: f.req(f.str),
  sourceId: f.req(f.str),
  expectedSourceRevision: f.req(f.u64),
  outputText: f.req(f.str),
  promptText: f.nul(f.str),
  promptCompleteness: f.req(f.en(...COMPLETENESS)),
  outputCompleteness: f.req(f.en(...COMPLETENESS)),
  workflowCompleteness: f.req(f.en(...COMPLETENESS)),
  evidenceVisibility: f.req(f.en(...EVIDENCE_VISIBILITY)),
  evidenceArtifactIds: f.req(f.arr(f.str)),
  snapshotBinding: f.nul(f.str),
  visibilityNote: f.nul(f.str),
  operator: f.nul(f.obj(operatorShape)),
  provider: f.nul(f.str),
  model: f.nul(f.str),
  version: f.nul(f.str),
  claimedTraces: f.req(f.arr(f.str)),
  uncertainty: f.nul(f.str),
  timing: f.nul(f.str),
  cost: f.nul(f.str),
  redacted: f.req(f.bool),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.nstr),
  clientTime: f.opt(f.str),
};

const importSuccessShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID)),
  importMode: f.req(f.en(...EXTERNAL_RUN_IMPORT_MODES)),
  caseId: f.req(f.str),
  sourceId: f.req(f.str),
  expectedSourceRevision: f.req(f.u64),
  replayed: f.req(f.bool),
  applied: f.req(f.str),
  contribution: f.req(f.str),
};

const importRefusedShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID)),
  error: f.req(f.en(EXTERNAL_RUN_IMPORT_ERROR)),
  importMode: f.req(f.en(...EXTERNAL_RUN_IMPORT_MODES)),
  caseId: f.req(f.str),
  sourceId: f.req(f.str),
  expectedSourceRevision: f.req(f.u64),
  reason: f.req(f.en(...EXTERNAL_RUN_IMPORT_REFUSALS)),
  detail: f.req(f.nstr),
  current: f.nul(f.str),
};

const CURRENT_NULL_REFUSALS: ReadonlySet<ExternalRunImportRefusal> = new Set([
  "case_archived",
  "privacy_mismatch",
  "idempotency_intent_mismatch",
]);

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
        throw new ContractViolation(`${path}[${index}]`, "sparse arrays are not valid contract data");
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

function hasLineBreak(value: string): boolean {
  // Matching line breaks is the point: metadata stays single-line.
  return /[\n\r\u2028\u2029]/.test(value);
}

function hasForbiddenMultilineSeparator(value: string): boolean {
  return /[\r\u2028\u2029]/.test(value);
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
  if (hasForbiddenMultilineSeparator(value) || hasDangerousUnicode(value.replaceAll("\n", ""))) {
    throw new ContractViolation(
      path,
      "control characters, bidi overrides, and Unicode line separators are not allowed",
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

function exactSafeMultiline(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if (value.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if ([...value].length > maxLength) {
    throw new ContractViolation(path, `expected at most ${maxLength} wire characters`);
  }
  assertSafeMultiline(value, path);
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

function nullableNormalizedText(
  value: unknown,
  path: string,
  maxLength: number,
  multiline: boolean,
): string | null {
  if (value === null) return null;
  return multiline
    ? normalizeMultilineText(value, path, maxLength)
    : normalizeCatalogText(value, path, maxLength);
}

function nullableExactText(
  value: unknown,
  path: string,
  maxLength: number,
  multiline: boolean,
): string | null {
  if (value === null) return null;
  return multiline
    ? exactSafeMultiline(value, path, maxLength)
    : exactSafeText(value, path, maxLength);
}

function requireUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !SOURCE_UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected a lower-case UUID");
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !EXTERNAL_RUN_SHA256_RE.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest");
  }
  return value;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nullableSha256(value: unknown, path: string): string | null {
  return value === null ? null : requireSha256(value, path);
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseExactRunBytes(
  outputText: unknown,
  promptText: unknown,
  outputPath: string,
  promptPath: string,
): { outputText: string; promptText: string | null } {
  if (typeof outputText !== "string") {
    throw new ContractViolation(outputPath, "expected string");
  }
  if (outputText.length === 0) {
    throw new ContractViolation(outputPath, "expected non-empty output bytes");
  }
  const prompt =
    promptText === null
      ? null
      : typeof promptText === "string"
        ? promptText
        : (() => {
            throw new ContractViolation(promptPath, "expected string");
          })();
  const combined =
    utf8ByteLength(outputText) + (prompt === null ? 0 : utf8ByteLength(prompt));
  if (combined > EXTERNAL_RUN_IMPORT_LIMITS.combinedTextMaxBytes) {
    throw new ContractViolation(
      outputPath,
      `output and prompt combined UTF-8 must be at most ${EXTERNAL_RUN_IMPORT_LIMITS.combinedTextMaxBytes} bytes`,
    );
  }
  return { outputText, promptText: prompt };
}

function parseEvidenceArtifactIds(
  value: unknown,
  path: string,
  mode: "sort" | "requireSorted",
): string[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation(path, "expected array");
  }
  if (value.length > EXTERNAL_RUN_IMPORT_LIMITS.evidenceArtifactIdsMax) {
    throw new ContractViolation(
      path,
      `expected at most ${EXTERNAL_RUN_IMPORT_LIMITS.evidenceArtifactIdsMax} evidence artifact ids`,
    );
  }
  const seen = new Set<string>();
  const parsed: string[] = [];
  value.forEach((item, index) => {
    const id = requireUuid(item, `${path}[${index}]`);
    if (seen.has(id)) {
      throw new ContractViolation(`${path}[${index}]`, "duplicate evidence artifact id");
    }
    seen.add(id);
    parsed.push(id);
  });
  const sorted = [...parsed].sort();
  if (mode === "requireSorted") {
    for (let index = 0; index < parsed.length; index += 1) {
      if (parsed[index] !== sorted[index]) {
        throw new ContractViolation(path, "must be in canonical lexical order");
      }
    }
    return parsed;
  }
  return sorted;
}

function parseClaimedTraces(
  value: unknown,
  path: string,
  mode: "normalize" | "exact",
): string[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation(path, "expected array");
  }
  if (value.length > EXTERNAL_RUN_IMPORT_LIMITS.claimedTracesMax) {
    throw new ContractViolation(
      path,
      `expected at most ${EXTERNAL_RUN_IMPORT_LIMITS.claimedTracesMax} claimed traces`,
    );
  }
  return value.map((item, index) =>
    mode === "normalize"
      ? normalizeCatalogText(
          item,
          `${path}[${index}]`,
          EXTERNAL_RUN_IMPORT_LIMITS.claimedTraceMaxLength,
        )
      : exactSafeText(
          item,
          `${path}[${index}]`,
          EXTERNAL_RUN_IMPORT_LIMITS.claimedTraceMaxLength,
        ),
  );
}

function assertPromptCompleteness(
  promptText: string | null,
  promptCompleteness: Completeness,
  path: string,
): void {
  if (promptText === null && promptCompleteness === "exact") {
    throw new ContractViolation(
      path,
      "promptCompleteness exact is forbidden when promptText is null",
    );
  }
}

function assertEvidenceVisibilityState(
  evidenceVisibility: EvidenceVisibility,
  evidenceArtifactIds: string[],
  snapshotBinding: string | null,
  visibilityNote: string | null,
  path: string,
): void {
  const described =
    evidenceArtifactIds.length > 0 ||
    snapshotBinding !== null ||
    visibilityNote !== null;
  if (evidenceVisibility === "unknown") {
    if (described) {
      throw new ContractViolation(
        path,
        "unknown evidence visibility requires zero artifact ids and null snapshot/visibilityNote",
      );
    }
    return;
  }
  if (!described) {
    throw new ContractViolation(
      path,
      "importer_described requires at least one artifact id, snapshot, or nonempty visibilityNote",
    );
  }
}

function parseClientTime(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, "expected string");
  }
  if ([...value].length > EXTERNAL_RUN_IMPORT_LIMITS.clientTimeMaxLength) {
    throw new ContractViolation(
      path,
      `expected at most ${EXTERNAL_RUN_IMPORT_LIMITS.clientTimeMaxLength} wire characters`,
    );
  }
  if (!isIsoInstant(value)) {
    throw new ContractViolation(path, "expected an ISO-8601 instant with an explicit offset");
  }
  return value;
}

function parseOperator(
  value: unknown,
  path: string,
  mode: "normalize" | "exact",
): ExternalRunOperatorV1 | null {
  if (value === null) return null;
  checkObject(path, operatorShape, value);
  const record = recordAt(value, path);
  const identityId =
    mode === "normalize"
      ? normalizeCatalogText(
          record.identityId,
          `${path}.identityId`,
          EXTERNAL_RUN_IMPORT_LIMITS.operatorIdentityMaxLength,
        )
      : exactSafeText(
          record.identityId,
          `${path}.identityId`,
          EXTERNAL_RUN_IMPORT_LIMITS.operatorIdentityMaxLength,
        );
  const username =
    mode === "normalize"
      ? normalizeCatalogText(
          record.username,
          `${path}.username`,
          EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength,
        )
      : exactSafeText(
          record.username,
          `${path}.username`,
          EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength,
        );
  return { identityId, username };
}

function isImportableSourceKind(kind: SourceKind): boolean {
  return (IMPORTABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

function checkShallowObject(
  path: string,
  shape: ObjectShape,
  raw: unknown,
  nestedFields: readonly string[],
): Record<string, unknown> {
  const record = recordAt(raw, path);
  const shallow: Record<string, unknown> = { ...record };
  for (const field of nestedFields) {
    if (Object.prototype.hasOwnProperty.call(shallow, field) && shallow[field] !== null) {
      shallow[field] = "nested";
    }
  }
  checkObject(path, shape, shallow);
  return record;
}

export function parseExternalRun(raw: unknown, path = "$"): ExternalRunV1 {
  checkObject(path, runShape, raw);
  const record = recordAt(raw, path);
  const importFieldPresence = ["importMode", "sourceRevision", "evidenceArtifactIds"].map((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
  if (importFieldPresence.some(Boolean) && !importFieldPresence.every(Boolean)) {
    throw new ContractViolation(
      path,
      "manual import fields importMode, sourceRevision, and evidenceArtifactIds must appear together",
    );
  }
  // Marked durable manual-import rows reuse AppliedImportedExternalRunV1 invariants.
  if (importFieldPresence.every(Boolean)) {
    return parseAppliedImportedRun(raw, path);
  }
  return raw as ExternalRunV1;
}

export function parseExternalRunImportRequest(raw: unknown): ExternalRunImportRequestV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", importRequestShape, raw);
  const record = recordAt(raw, "$");
  const bytes = parseExactRunBytes(
    record.outputText,
    record.promptText,
    "$.outputText",
    "$.promptText",
  );
  const promptCompleteness = record.promptCompleteness as Completeness;
  assertPromptCompleteness(bytes.promptText, promptCompleteness, "$.promptCompleteness");
  const evidenceArtifactIds = parseEvidenceArtifactIds(
    record.evidenceArtifactIds,
    "$.evidenceArtifactIds",
    "sort",
  );
  const snapshotBinding = nullableSha256(record.snapshotBinding, "$.snapshotBinding");
  const visibilityNote = nullableNormalizedText(
    record.visibilityNote,
    "$.visibilityNote",
    EXTERNAL_RUN_IMPORT_LIMITS.visibilityNoteMaxLength,
    true,
  );
  assertEvidenceVisibilityState(
    record.evidenceVisibility as EvidenceVisibility,
    evidenceArtifactIds,
    snapshotBinding,
    visibilityNote,
    "$.evidenceVisibility",
  );
  const parsed: ExternalRunImportRequestV1 = {
    schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
    importMode: "manual",
    caseId: requireUuid(record.caseId, "$.caseId"),
    sourceId: requireUuid(record.sourceId, "$.sourceId"),
    expectedSourceRevision: requireRevisionAtLeastOne(
      record.expectedSourceRevision,
      "$.expectedSourceRevision",
    ),
    outputText: bytes.outputText,
    promptText: bytes.promptText,
    promptCompleteness,
    outputCompleteness: record.outputCompleteness as Completeness,
    workflowCompleteness: record.workflowCompleteness as Completeness,
    evidenceVisibility: record.evidenceVisibility as EvidenceVisibility,
    evidenceArtifactIds,
    snapshotBinding,
    visibilityNote,
    operator: parseOperator(record.operator, "$.operator", "normalize"),
    provider: nullableNormalizedText(
      record.provider,
      "$.provider",
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    model: nullableNormalizedText(
      record.model,
      "$.model",
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    version: nullableNormalizedText(
      record.version,
      "$.version",
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    claimedTraces: parseClaimedTraces(record.claimedTraces, "$.claimedTraces", "normalize"),
    uncertainty: nullableNormalizedText(
      record.uncertainty,
      "$.uncertainty",
      EXTERNAL_RUN_IMPORT_LIMITS.uncertaintyMaxLength,
      true,
    ),
    timing: nullableNormalizedText(
      record.timing,
      "$.timing",
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    cost: nullableNormalizedText(
      record.cost,
      "$.cost",
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    redacted: record.redacted === true,
    privacyClass: record.privacyClass as PrivacyClass,
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey, "$.idempotencyKey"),
  };
  if (record.clientTime !== undefined) {
    parsed.clientTime = parseClientTime(record.clientTime, "$.clientTime");
  }
  return parsed;
}

function parseAppliedImportedRun(
  raw: unknown,
  path: string,
): AppliedImportedExternalRunV1 {
  checkObject(path, appliedRunShape, raw);
  const record = recordAt(raw, path);
  const bytes = parseExactRunBytes(
    record.outputText,
    record.promptText,
    `${path}.outputText`,
    `${path}.promptText`,
  );
  const promptHash = nullableSha256(record.promptHash, `${path}.promptHash`);
  if ((bytes.promptText === null) !== (promptHash === null)) {
    throw new ContractViolation(
      `${path}.promptHash`,
      "promptHash must be null if and only if promptText is null",
    );
  }
  const outputHash = requireSha256(record.outputHash, `${path}.outputHash`);
  if (outputHash !== sha256Utf8(bytes.outputText)) {
    throw new ContractViolation(
      `${path}.outputHash`,
      "must match the SHA-256 digest of the exact outputText UTF-8 bytes",
    );
  }
  if (bytes.promptText !== null && promptHash !== sha256Utf8(bytes.promptText)) {
    throw new ContractViolation(
      `${path}.promptHash`,
      "must match the SHA-256 digest of the exact promptText UTF-8 bytes",
    );
  }
  const promptCompleteness = record.promptCompleteness as Completeness;
  assertPromptCompleteness(
    bytes.promptText,
    promptCompleteness,
    `${path}.promptCompleteness`,
  );
  const evidenceArtifactIds = parseEvidenceArtifactIds(
    record.evidenceArtifactIds,
    `${path}.evidenceArtifactIds`,
    "requireSorted",
  );
  const snapshotBinding = nullableSha256(record.snapshotBinding, `${path}.snapshotBinding`);
  const visibilityNote = nullableExactText(
    record.visibilityNote,
    `${path}.visibilityNote`,
    EXTERNAL_RUN_IMPORT_LIMITS.visibilityNoteMaxLength,
    true,
  );
  assertEvidenceVisibilityState(
    record.evidenceVisibility as EvidenceVisibility,
    evidenceArtifactIds,
    snapshotBinding,
    visibilityNote,
    `${path}.evidenceVisibility`,
  );
  const createdAt = record.createdAt;
  if (typeof createdAt !== "string" || !isIsoInstant(createdAt)) {
    throw new ContractViolation(`${path}.createdAt`, "expected an ISO-8601 instant");
  }
  if (record.corroborationState !== "unverified") {
    throw new ContractViolation(
      `${path}.corroborationState`,
      "successful import must record unverified corroboration",
    );
  }
  return {
    schemaId: EXTERNAL_RUN_SCHEMA_ID,
    id: requireUuid(record.id, `${path}.id`),
    caseId: requireUuid(record.caseId, `${path}.caseId`),
    contributionId: requireUuid(record.contributionId, `${path}.contributionId`),
    sourceId: requireUuid(record.sourceId, `${path}.sourceId`),
    outputHash,
    outputText: bytes.outputText,
    promptHash,
    promptText: bytes.promptText,
    promptCompleteness,
    outputCompleteness: record.outputCompleteness as Completeness,
    workflowCompleteness: record.workflowCompleteness as Completeness,
    evidenceVisibility: record.evidenceVisibility as EvidenceVisibility,
    snapshotBinding,
    visibilityNote,
    importerId: exactSafeText(
      record.importerId,
      `${path}.importerId`,
      EXTERNAL_RUN_IMPORT_LIMITS.operatorIdentityMaxLength,
    ),
    importerUsername: exactSafeText(
      record.importerUsername,
      `${path}.importerUsername`,
      EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength,
    ),
    operatorId: exactSafeText(
      record.operatorId,
      `${path}.operatorId`,
      EXTERNAL_RUN_IMPORT_LIMITS.operatorIdentityMaxLength,
    ),
    operatorUsername: exactSafeText(
      record.operatorUsername,
      `${path}.operatorUsername`,
      EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength,
    ),
    provider: nullableExactText(
      record.provider,
      `${path}.provider`,
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    model: nullableExactText(
      record.model,
      `${path}.model`,
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    version: nullableExactText(
      record.version,
      `${path}.version`,
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    claimedTraces: parseClaimedTraces(record.claimedTraces, `${path}.claimedTraces`, "exact"),
    uncertainty: nullableExactText(
      record.uncertainty,
      `${path}.uncertainty`,
      EXTERNAL_RUN_IMPORT_LIMITS.uncertaintyMaxLength,
      true,
    ),
    timing: nullableExactText(
      record.timing,
      `${path}.timing`,
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    cost: nullableExactText(
      record.cost,
      `${path}.cost`,
      EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength,
      false,
    ),
    redacted: record.redacted === true,
    privacyClass: record.privacyClass as PrivacyClass,
    corroborationState: "unverified",
    createdAt,
    importMode: "manual",
    sourceRevision: requireRevisionAtLeastOne(record.sourceRevision, `${path}.sourceRevision`),
    evidenceArtifactIds,
  };
}

function parseImportContribution(raw: unknown, path: string): ContributionV1 {
  let parsed: ContributionV1;
  try {
    parsed = parseContribution(raw);
  } catch (error) {
    if (error instanceof ContractViolation) {
      throw new ContractViolation(error.path.replace(/^\$/, path), error.detail);
    }
    throw error;
  }
  requireUuid(parsed.id, `${path}.id`);
  requireUuid(parsed.caseId, `${path}.caseId`);
  requireUuid(parsed.sourceId, `${path}.sourceId`);
  exactSafeText(
    parsed.authorId,
    `${path}.authorId`,
    EXTERNAL_RUN_IMPORT_LIMITS.operatorIdentityMaxLength,
  );
  exactSafeText(
    parsed.authorUsername,
    `${path}.authorUsername`,
    EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength,
  );
  if (!isIsoInstant(parsed.createdAt)) {
    throw new ContractViolation(`${path}.createdAt`, "expected an ISO-8601 instant");
  }
  if (parsed.kind !== "external_run") {
    throw new ContractViolation(`${path}.kind`, "successful import contribution must be external_run");
  }
  if (parsed.revision !== 1) {
    throw new ContractViolation(`${path}.revision`, "successful import contribution revision must be 1");
  }
  if (parsed.predecessorRevision !== null) {
    throw new ContractViolation(
      `${path}.predecessorRevision`,
      "successful import contribution predecessor must be null",
    );
  }
  if (parsed.tombstoned !== false) {
    throw new ContractViolation(
      `${path}.tombstoned`,
      "successful import contribution must not be tombstoned",
    );
  }
  if (parsed.contentHash.length < 1) {
    throw new ContractViolation(`${path}.contentHash`, "expected non-empty text");
  }
  if (parsed.hypothesisStatus !== null) {
    throw new ContractViolation(
      `${path}.hypothesisStatus`,
      "successful import contribution hypothesisStatus must be null",
    );
  }
  if (parsed.hypothesisLinks !== null) {
    throw new ContractViolation(
      `${path}.hypothesisLinks`,
      "successful import contribution hypothesisLinks must be null",
    );
  }
  return parsed;
}

export function parseExternalRunImportSuccess(raw: unknown): ExternalRunImportSuccessV1 {
  assertPlainDataTree(raw, "$");
  const record = checkShallowObject("$", importSuccessShape, raw, ["applied", "contribution"]);
  const caseId = requireUuid(record.caseId, "$.caseId");
  const sourceId = requireUuid(record.sourceId, "$.sourceId");
  const expectedSourceRevision = requireRevisionAtLeastOne(
    record.expectedSourceRevision,
    "$.expectedSourceRevision",
  );
  const applied = parseAppliedImportedRun(record.applied, "$.applied");
  const contribution = parseImportContribution(record.contribution, "$.contribution");

  if (applied.caseId !== caseId) {
    throw new ContractViolation("$.applied.caseId", "must match caseId");
  }
  if (applied.sourceId !== sourceId) {
    throw new ContractViolation("$.applied.sourceId", "must match sourceId");
  }
  if (applied.sourceRevision !== expectedSourceRevision) {
    throw new ContractViolation("$.applied.sourceRevision", "must equal expectedSourceRevision");
  }
  if (applied.contributionId !== contribution.id) {
    throw new ContractViolation("$.applied.contributionId", "must equal contribution.id");
  }
  if (contribution.caseId !== caseId) {
    throw new ContractViolation("$.contribution.caseId", "must match caseId");
  }
  if (contribution.sourceId !== sourceId) {
    throw new ContractViolation("$.contribution.sourceId", "must match sourceId");
  }
  if (contribution.privacyClass !== applied.privacyClass) {
    throw new ContractViolation("$.contribution.privacyClass", "must match applied.privacyClass");
  }
  if (contribution.authorId !== applied.importerId) {
    throw new ContractViolation("$.contribution.authorId", "must match applied.importerId");
  }
  if (contribution.authorUsername !== applied.importerUsername) {
    throw new ContractViolation(
      "$.contribution.authorUsername",
      "must match applied.importerUsername",
    );
  }

  return {
    schemaId: EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
    importMode: "manual",
    caseId,
    sourceId,
    expectedSourceRevision,
    replayed: record.replayed === true,
    applied,
    contribution,
  };
}

export function parseExternalRunImportRefused(raw: unknown): ExternalRunImportRefusedV1 {
  assertPlainDataTree(raw, "$");
  const record = checkShallowObject("$", importRefusedShape, raw, ["current"]);
  const reason = record.reason as ExternalRunImportRefusal;
  const caseId = requireUuid(record.caseId, "$.caseId");
  const sourceId = requireUuid(record.sourceId, "$.sourceId");
  const expectedSourceRevision = requireRevisionAtLeastOne(
    record.expectedSourceRevision,
    "$.expectedSourceRevision",
  );
  const detail = normalizeCatalogText(
    record.detail,
    "$.detail",
    EXTERNAL_RUN_IMPORT_LIMITS.refusalDetailMaxLength,
  );
  const current =
    record.current === null ? null : parseSource(record.current, "$.current");

  if (CURRENT_NULL_REFUSALS.has(reason)) {
    if (current !== null) {
      throw new ContractViolation("$.current", `${reason} requires current to be null`);
    }
  } else if (current === null) {
    throw new ContractViolation("$.current", `${reason} requires a current source`);
  } else if (current.id !== sourceId) {
    throw new ContractViolation("$.current.id", "must match sourceId");
  }

  if (reason === "source_not_versioned") {
    if (current === null || current.revision !== undefined) {
      throw new ContractViolation(
        "$.current.revision",
        "source_not_versioned requires a current source with no revision",
      );
    }
  }

  if (reason === "source_retired") {
    if (current === null || current.lifecycle !== "retired" || current.revision === undefined) {
      throw new ContractViolation(
        "$.current",
        "source_retired requires a matching retired versioned source",
      );
    }
  }

  if (reason === "source_revision_mismatch") {
    if (
      current === null ||
      current.lifecycle !== "active" ||
      current.revision === undefined
    ) {
      throw new ContractViolation(
        "$.current",
        "source_revision_mismatch requires a matching active versioned source",
      );
    }
    if (current.revision === expectedSourceRevision) {
      throw new ContractViolation(
        "$.current.revision",
        "source_revision_mismatch requires current.revision to differ",
      );
    }
  }

  if (reason === "source_kind_not_importable") {
    if (
      current === null ||
      current.lifecycle !== "active" ||
      current.revision === undefined ||
      current.revision !== expectedSourceRevision ||
      isImportableSourceKind(current.kind)
    ) {
      throw new ContractViolation(
        "$.current",
        "source_kind_not_importable requires a matching active source at the expected revision of a nonimportable kind",
      );
    }
  }

  return {
    schemaId: EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_IMPORT_ERROR,
    importMode: "manual",
    caseId,
    sourceId,
    expectedSourceRevision,
    reason,
    detail,
    current,
  };
}
