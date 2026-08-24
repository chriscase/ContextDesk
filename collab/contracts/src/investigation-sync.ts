/**
 * Fail-closed, transport-neutral foundation for a future local/shared
 * investigation synchronization protocol. This module only parses,
 * canonicalizes, fingerprints, and dry-run plans append-only operations.
 * It performs no networking, persistence, authorization, or automatic sync.
 */
import { createHash } from "node:crypto";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import {
  PORTABLE_OBJECT_KINDS,
  assertNoCredentialLeakage,
  canonicalJson,
  type PortableObjectKind,
} from "./investigation-portable.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafeTimestamp } from "./privacy.js";

export const INVESTIGATION_SYNC_SCHEMA_ID =
  "cd-collab.investigation_sync_batch.v1" as const;
export const INVESTIGATION_SYNC_PLAN_SCHEMA_ID =
  "cd-collab.investigation_sync_plan.v1" as const;
export const INVESTIGATION_SYNC_STATE_SCHEMA_ID =
  "cd-collab.investigation_sync_destination_state.v1" as const;

export const INVESTIGATION_SYNC_EXCLUSIONS = [
  "authentication_credentials",
  "membership",
  "roles",
  "capabilities",
] as const;

export const SYNC_MUTATIONS = ["upsert", "tombstone"] as const;
export type SyncMutation = (typeof SYNC_MUTATIONS)[number];

export const SYNC_ACTOR_KINDS = ["human", "service", "imported_external"] as const;
export type SyncActorKind = (typeof SYNC_ACTOR_KINDS)[number];

export const SYNC_OBJECT_KINDS = PORTABLE_OBJECT_KINDS.filter(
  (kind) => kind !== "actor",
) as Exclude<PortableObjectKind, "actor">[];
export type SyncObjectKind = (typeof SYNC_OBJECT_KINDS)[number];

export const SYNC_CONFLICT_CODES = [
  "source_loop",
  "cursor_mismatch",
  "operation_identity_collision",
  "source_sequence_collision",
  "partial_replay",
  "object_missing",
  "object_already_exists",
  "revision_conflict",
  "base_hash_conflict",
  "privacy_class_not_accepted",
  "privacy_widening",
  "resurrection_forbidden",
] as const;
export type SyncConflictCode = (typeof SYNC_CONFLICT_CODES)[number];

const SHA256_HEX = /^[a-f0-9]{64}$/;
const INSTALLATION_ID = /^inst-[a-z0-9]{8,64}$/;
const OPERATION_ID = /^syncop-[a-z0-9]{12,96}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_AUTHORITY_KEY =
  /^(?:credential|credentials|authentication|membership|memberships|role|roles|capability|capabilities|permission|permissions|grant|grants)$/i;

export interface SyncActorAttributionV1 {
  sourceActorId: string;
  displayName: string;
  kind: SyncActorKind;
}

export interface SyncObjectMutationV1 {
  kind: SyncObjectKind;
  objectId: string;
  baseRevision: number;
  resultRevision: number;
  baseHash: string | null;
  resultHash: string;
  privacyClass: PrivacyClass;
}

export interface InvestigationSyncOperationV1 {
  operationId: string;
  sourceInstallationId: string;
  sourceSequence: number;
  previousOperationFingerprint: string | null;
  emittedAt: string;
  investigationId: string;
  actor: SyncActorAttributionV1;
  mutation: SyncMutation;
  object: SyncObjectMutationV1;
  payloadJson: string | null;
  tombstoneReason: string | null;
  operationFingerprint: string;
}

export interface InvestigationSyncCursorV1 {
  sourceInstallationId: string;
  throughSequence: number;
  lastOperationId: string | null;
  lastOperationFingerprint: string | null;
}

export interface InvestigationSyncBatchV1 {
  schemaId: typeof INVESTIGATION_SYNC_SCHEMA_ID;
  sourceInstallationId: string;
  investigationId: string;
  fromCursor: InvestigationSyncCursorV1;
  toCursor: InvestigationSyncCursorV1;
  operations: InvestigationSyncOperationV1[];
  exclusions: typeof INVESTIGATION_SYNC_EXCLUSIONS;
  automaticSync: false;
  networkingIncluded: false;
  batchFingerprint: string;
}

export type InvestigationSyncBatchUnsignedV1 = Omit<
  InvestigationSyncBatchV1,
  | "schemaId"
  | "toCursor"
  | "exclusions"
  | "automaticSync"
  | "networkingIncluded"
  | "batchFingerprint"
> & {
  operations: Array<Omit<InvestigationSyncOperationV1, "operationFingerprint" | "previousOperationFingerprint">>;
};

export interface SyncDestinationObjectV1 {
  sourceInstallationId: string;
  kind: SyncObjectKind;
  objectId: string;
  revision: number;
  objectHash: string | null;
  privacyClass: PrivacyClass;
  tombstoned: boolean;
}

export interface AppliedSyncOperationV1 {
  operationId: string;
  operationFingerprint: string;
  sourceInstallationId: string;
  sourceSequence: number;
}

export interface InvestigationSyncDestinationStateV1 {
  schemaId: typeof INVESTIGATION_SYNC_STATE_SCHEMA_ID;
  destinationInstallationId: string;
  investigationId: string;
  checkpoint: InvestigationSyncCursorV1;
  acceptedPrivacyClasses: PrivacyClass[];
  objects: SyncDestinationObjectV1[];
  appliedOperations: AppliedSyncOperationV1[];
}

export interface SyncConflictV1 {
  code: SyncConflictCode;
  operationId: string | null;
  sourceSequence: number | null;
  objectKind: SyncObjectKind | null;
  objectId: string | null;
  detail: string;
}

export interface PlannedSyncOperationV1 {
  operationId: string;
  sourceSequence: number;
  action: "apply" | "replay" | "blocked";
}

export interface InvestigationSyncPlanV1 {
  schemaId: typeof INVESTIGATION_SYNC_PLAN_SCHEMA_ID;
  mode: "dry_run";
  outcome: "apply" | "replay" | "blocked";
  batchFingerprint: string;
  sourceInstallationId: string;
  destinationInstallationId: string;
  investigationId: string;
  operations: PlannedSyncOperationV1[];
  conflicts: SyncConflictV1[];
  destinationStateFingerprint: string;
  planFingerprint: string;
  checkpointBefore: InvestigationSyncCursorV1;
  checkpointAfter: InvestigationSyncCursorV1;
  applyAuthorized: false;
  automaticSync: false;
  networkingIncluded: false;
  credentialsTransferred: false;
  membershipGranted: false;
  rolesGranted: false;
  capabilitiesGranted: false;
  exclusions: typeof INVESTIGATION_SYNC_EXCLUSIONS;
}

const actorShape: ObjectShape = {
  sourceActorId: f.req(f.nstr),
  displayName: f.req(f.nstr),
  kind: f.req(f.en(...SYNC_ACTOR_KINDS)),
};

const objectMutationShape: ObjectShape = {
  kind: f.req(f.en(...SYNC_OBJECT_KINDS)),
  objectId: f.req(f.nstr),
  baseRevision: f.req(f.u64),
  resultRevision: f.req(f.u64),
  baseHash: f.nul(f.str),
  resultHash: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

const operationShape: ObjectShape = {
  operationId: f.req(f.nstr),
  sourceInstallationId: f.req(f.nstr),
  sourceSequence: f.req(f.u64),
  previousOperationFingerprint: f.nul(f.str),
  emittedAt: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  actor: f.req(f.obj(actorShape)),
  mutation: f.req(f.en(...SYNC_MUTATIONS)),
  object: f.req(f.obj(objectMutationShape)),
  payloadJson: f.nul(f.str),
  tombstoneReason: f.nul(f.str),
  operationFingerprint: f.req(f.str),
};

const cursorShape: ObjectShape = {
  sourceInstallationId: f.req(f.nstr),
  throughSequence: f.req(f.u64),
  lastOperationId: f.nul(f.str),
  lastOperationFingerprint: f.nul(f.str),
};

const batchShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_SYNC_SCHEMA_ID)),
  sourceInstallationId: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  fromCursor: f.req(f.obj(cursorShape)),
  toCursor: f.req(f.obj(cursorShape)),
  operations: f.req(f.arr(f.obj(operationShape))),
  exclusions: f.req(f.arr(f.en(...INVESTIGATION_SYNC_EXCLUSIONS))),
  automaticSync: f.req(f.bool),
  networkingIncluded: f.req(f.bool),
  batchFingerprint: f.req(f.str),
};

const destinationObjectShape: ObjectShape = {
  sourceInstallationId: f.req(f.nstr),
  kind: f.req(f.en(...SYNC_OBJECT_KINDS)),
  objectId: f.req(f.nstr),
  revision: f.req(f.u64),
  objectHash: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  tombstoned: f.req(f.bool),
};

const appliedOperationShape: ObjectShape = {
  operationId: f.req(f.nstr),
  operationFingerprint: f.req(f.str),
  sourceInstallationId: f.req(f.nstr),
  sourceSequence: f.req(f.u64),
};

const destinationStateShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_SYNC_STATE_SCHEMA_ID)),
  destinationInstallationId: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  checkpoint: f.req(f.obj(cursorShape)),
  acceptedPrivacyClasses: f.req(f.arr(f.en(...PRIVACY_CLASSES))),
  objects: f.req(f.arr(f.obj(destinationObjectShape))),
  appliedOperations: f.req(f.arr(f.obj(appliedOperationShape))),
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireSha256(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected lowercase SHA-256 hex digest");
  }
}

function requireInstallationId(path: string, value: string): void {
  if (!INSTALLATION_ID.test(value)) {
    throw new ContractViolation(path, "expected opaque inst-* installation id");
  }
}

function requireOperationId(path: string, value: string): void {
  if (!OPERATION_ID.test(value)) {
    throw new ContractViolation(path, "expected opaque syncop-* operation id");
  }
}

function requireOpaqueId(path: string, value: string): void {
  if (!OPAQUE_ID.test(value)) {
    throw new ContractViolation(path, "expected a bounded opaque identifier");
  }
}

function hasDisallowedText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        codePoint === 0xfeff)
    ) {
      return true;
    }
  }
  return false;
}

function requireSafeText(path: string, value: string): void {
  if (!value.trim() || hasDisallowedText(value)) {
    throw new ContractViolation(path, "must be non-empty text without control or zero-width characters");
  }
}

function assertNoAuthorityPayload(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (hasDisallowedText(value)) {
      throw new ContractViolation(path, "control or zero-width character in payload");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoAuthorityPayload(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      hasDisallowedText(key) ||
      FORBIDDEN_AUTHORITY_KEY.test(key) ||
      ["credential", "authentication", "membership", "role", "capability", "permission", "grant"].some(
        (term) => normalized.includes(term),
      )
    ) {
      throw new ContractViolation(
        `${path}.${key}`,
        "authority, membership, role, or capability data is excluded from sync",
      );
    }
    assertNoAuthorityPayload(child, `${path}.${key}`);
  }
}

function parseCanonicalPayload(path: string, raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ContractViolation(path, "payloadJson must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation(path, "payloadJson must encode a JSON object");
  }
  assertNoCredentialLeakage(value, path);
  assertNoAuthorityPayload(value, path);
  const canonical = canonicalJson(value);
  if (canonical !== raw) {
    throw new ContractViolation(path, "payloadJson must use canonical JSON key ordering");
  }
  return canonical;
}

function operationUnsigned(operation: InvestigationSyncOperationV1): unknown {
  const { operationFingerprint: _fingerprint, ...unsigned } = operation;
  return unsigned;
}

export function investigationSyncOperationFingerprint(
  operation: InvestigationSyncOperationV1,
): string {
  return sha256(canonicalJson(operationUnsigned(operation)));
}

export interface InvestigationSyncObjectHashInputV1 {
  sourceInstallationId: string;
  investigationId: string;
  kind: SyncObjectKind;
  objectId: string;
  revision: number;
  privacyClass: PrivacyClass;
  tombstoned: boolean;
  payloadJson: string | null;
  tombstoneReason: string | null;
}

export function investigationSyncObjectHash(input: InvestigationSyncObjectHashInputV1): string {
  return sha256(
    canonicalJson({
      sourceInstallationId: input.sourceInstallationId,
      investigationId: input.investigationId,
      kind: input.kind,
      objectId: input.objectId,
      revision: input.revision,
      privacyClass: input.privacyClass,
      tombstoned: input.tombstoned,
      payloadHash: input.payloadJson === null ? null : sha256(input.payloadJson),
      tombstoneReasonHash:
        input.tombstoneReason === null ? null : sha256(input.tombstoneReason),
    }),
  );
}

function batchUnsigned(batch: InvestigationSyncBatchV1): unknown {
  const { batchFingerprint: _fingerprint, ...unsigned } = batch;
  return unsigned;
}

export function investigationSyncBatchFingerprint(batch: InvestigationSyncBatchV1): string {
  return sha256(canonicalJson(batchUnsigned(batch)));
}

function validateCursor(path: string, cursor: InvestigationSyncCursorV1): void {
  requireInstallationId(`${path}.sourceInstallationId`, cursor.sourceInstallationId);
  if (cursor.throughSequence === 0) {
    if (cursor.lastOperationId !== null || cursor.lastOperationFingerprint !== null) {
      throw new ContractViolation(path, "zero cursor must not claim a last operation");
    }
    return;
  }
  if (cursor.lastOperationId === null || cursor.lastOperationFingerprint === null) {
    throw new ContractViolation(path, "non-zero cursor requires last operation identity and fingerprint");
  }
  requireOperationId(`${path}.lastOperationId`, cursor.lastOperationId);
  requireSha256(`${path}.lastOperationFingerprint`, cursor.lastOperationFingerprint);
}

function validateOperation(path: string, operation: InvestigationSyncOperationV1): void {
  requireOperationId(`${path}.operationId`, operation.operationId);
  requireInstallationId(`${path}.sourceInstallationId`, operation.sourceInstallationId);
  if (operation.sourceSequence < 1) {
    throw new ContractViolation(`${path}.sourceSequence`, "source sequence must be >= 1");
  }
  assertShareSafeTimestamp(`${path}.emittedAt`, operation.emittedAt);
  requireOpaqueId(`${path}.investigationId`, operation.investigationId);
  requireOpaqueId(`${path}.actor.sourceActorId`, operation.actor.sourceActorId);
  requireSafeText(`${path}.actor.displayName`, operation.actor.displayName);
  requireOpaqueId(`${path}.object.objectId`, operation.object.objectId);
  if (operation.object.resultRevision !== operation.object.baseRevision + 1) {
    throw new ContractViolation(`${path}.object.resultRevision`, "must equal baseRevision + 1");
  }
  if (operation.object.baseRevision === 0) {
    if (operation.object.baseHash !== null) {
      throw new ContractViolation(`${path}.object.baseHash`, "create operation must have null base hash");
    }
  } else if (operation.object.baseHash === null) {
    throw new ContractViolation(`${path}.object.baseHash`, "existing revision requires a base hash");
  }
  if (operation.object.baseHash !== null) {
    requireSha256(`${path}.object.baseHash`, operation.object.baseHash);
  }
  if (operation.mutation === "upsert") {
    if (operation.payloadJson === null || operation.tombstoneReason !== null) {
      throw new ContractViolation(path, "upsert requires payloadJson and forbids tombstoneReason");
    }
    const payload = parseCanonicalPayload(`${path}.payloadJson`, operation.payloadJson);
    const expectedResultHash = investigationSyncObjectHash({
      sourceInstallationId: operation.sourceInstallationId,
      investigationId: operation.investigationId,
      kind: operation.object.kind,
      objectId: operation.object.objectId,
      revision: operation.object.resultRevision,
      privacyClass: operation.object.privacyClass,
      tombstoned: false,
      payloadJson: payload,
      tombstoneReason: null,
    });
    if (operation.object.resultHash !== expectedResultHash) {
      throw new ContractViolation(`${path}.object.resultHash`, "must hash the complete canonical object envelope");
    }
  } else {
    if (operation.object.baseRevision === 0) {
      throw new ContractViolation(path, "cannot tombstone a never-created object");
    }
    if (operation.payloadJson !== null) {
      throw new ContractViolation(path, "tombstone forbids payload");
    }
    if (operation.tombstoneReason === null || !operation.tombstoneReason.trim()) {
      throw new ContractViolation(`${path}.tombstoneReason`, "tombstone requires a reason");
    }
    assertNoCredentialLeakage(operation.tombstoneReason, `${path}.tombstoneReason`);
    const expectedResultHash = investigationSyncObjectHash({
      sourceInstallationId: operation.sourceInstallationId,
      investigationId: operation.investigationId,
      kind: operation.object.kind,
      objectId: operation.object.objectId,
      revision: operation.object.resultRevision,
      privacyClass: operation.object.privacyClass,
      tombstoned: true,
      payloadJson: null,
      tombstoneReason: operation.tombstoneReason,
    });
    if (operation.object.resultHash !== expectedResultHash) {
      throw new ContractViolation(`${path}.object.resultHash`, "must hash the complete canonical tombstone envelope");
    }
  }
  if (operation.object.resultHash === null) {
    throw new ContractViolation(`${path}.object.resultHash`, "result hash is required");
  }
  requireSha256(`${path}.object.resultHash`, operation.object.resultHash);
  requireSha256(`${path}.operationFingerprint`, operation.operationFingerprint);
  if (investigationSyncOperationFingerprint(operation) !== operation.operationFingerprint) {
    throw new ContractViolation(`${path}.operationFingerprint`, "operation fingerprint mismatch");
  }
}

export function attachInvestigationSyncIntegrity(
  unsigned: InvestigationSyncBatchUnsignedV1,
): InvestigationSyncBatchV1 {
  const ordered = [...unsigned.operations].sort((left, right) => left.sourceSequence - right.sourceSequence);
  let previousFingerprint = unsigned.fromCursor.lastOperationFingerprint;
  const operations = ordered.map((row) => {
    const provisional = {
      ...row,
      previousOperationFingerprint: previousFingerprint,
      operationFingerprint: "",
    } as InvestigationSyncOperationV1;
    provisional.operationFingerprint = investigationSyncOperationFingerprint(provisional);
    previousFingerprint = provisional.operationFingerprint;
    return provisional;
  });
  const last = operations.at(-1);
  const batch = {
    schemaId: INVESTIGATION_SYNC_SCHEMA_ID,
    sourceInstallationId: unsigned.sourceInstallationId,
    investigationId: unsigned.investigationId,
    fromCursor: { ...unsigned.fromCursor },
    toCursor: last
      ? {
          sourceInstallationId: unsigned.sourceInstallationId,
          throughSequence: last.sourceSequence,
          lastOperationId: last.operationId,
          lastOperationFingerprint: last.operationFingerprint,
        }
      : { ...unsigned.fromCursor },
    operations,
    exclusions: INVESTIGATION_SYNC_EXCLUSIONS,
    automaticSync: false,
    networkingIncluded: false,
    batchFingerprint: "",
  } satisfies InvestigationSyncBatchV1;
  batch.batchFingerprint = investigationSyncBatchFingerprint(batch);
  return batch;
}

export function canonicalizeInvestigationSyncBatch(
  batch: InvestigationSyncBatchV1,
): InvestigationSyncBatchV1 {
  const operations = [...batch.operations].sort((left, right) => left.sourceSequence - right.sourceSequence);
  const canonical: InvestigationSyncBatchV1 = {
    ...batch,
    operations,
    exclusions: INVESTIGATION_SYNC_EXCLUSIONS,
  };
  canonical.batchFingerprint = investigationSyncBatchFingerprint(canonical);
  return canonical;
}

export function parseInvestigationSyncBatch(raw: unknown): InvestigationSyncBatchV1 {
  checkObject("$", batchShape, raw);
  const batch = raw as InvestigationSyncBatchV1;
  assertNoCredentialLeakage(batch);
  requireInstallationId("$.sourceInstallationId", batch.sourceInstallationId);
  validateCursor("$.fromCursor", batch.fromCursor);
  validateCursor("$.toCursor", batch.toCursor);
  if (
    batch.fromCursor.sourceInstallationId !== batch.sourceInstallationId ||
    batch.toCursor.sourceInstallationId !== batch.sourceInstallationId
  ) {
    throw new ContractViolation("$", "batch and cursor source installations must match");
  }
  requireOpaqueId("$.investigationId", batch.investigationId);
  if (canonicalJson(batch.exclusions) !== canonicalJson(INVESTIGATION_SYNC_EXCLUSIONS)) {
    throw new ContractViolation("$.exclusions", "required sync exclusions must be exact and ordered");
  }
  if (batch.automaticSync !== false || batch.networkingIncluded !== false) {
    throw new ContractViolation("$", "V1 is dry-run only and includes no networking or automatic sync");
  }
  let expectedSequence = batch.fromCursor.throughSequence + 1;
  let previousFingerprint = batch.fromCursor.lastOperationFingerprint;
  const ids = new Set<string>();
  for (const [index, operation] of batch.operations.entries()) {
    const path = `$.operations[${index}]`;
    validateOperation(path, operation);
    if (operation.sourceInstallationId !== batch.sourceInstallationId) {
      throw new ContractViolation(`${path}.sourceInstallationId`, "must match batch source");
    }
    if (operation.investigationId !== batch.investigationId) {
      throw new ContractViolation(`${path}.investigationId`, "must match batch investigation");
    }
    if (operation.sourceSequence !== expectedSequence) {
      throw new ContractViolation(`${path}.sourceSequence`, "operations must be contiguous and ordered");
    }
    if (operation.previousOperationFingerprint !== previousFingerprint) {
      throw new ContractViolation(`${path}.previousOperationFingerprint`, "append-only chain mismatch");
    }
    if (ids.has(operation.operationId)) {
      throw new ContractViolation(`${path}.operationId`, "duplicate operation id");
    }
    ids.add(operation.operationId);
    expectedSequence += 1;
    previousFingerprint = operation.operationFingerprint;
  }
  const expectedTo = batch.operations.at(-1)
    ? {
        sourceInstallationId: batch.sourceInstallationId,
        throughSequence: batch.operations.at(-1)!.sourceSequence,
        lastOperationId: batch.operations.at(-1)!.operationId,
        lastOperationFingerprint: batch.operations.at(-1)!.operationFingerprint,
      }
    : batch.fromCursor;
  if (canonicalJson(batch.toCursor) !== canonicalJson(expectedTo)) {
    throw new ContractViolation("$.toCursor", "does not identify the batch chain tip");
  }
  requireSha256("$.batchFingerprint", batch.batchFingerprint);
  if (investigationSyncBatchFingerprint(batch) !== batch.batchFingerprint) {
    throw new ContractViolation("$.batchFingerprint", "batch fingerprint mismatch");
  }
  return canonicalizeInvestigationSyncBatch(batch);
}

function objectKey(sourceInstallationId: string, kind: SyncObjectKind, objectId: string): string {
  return `${sourceInstallationId}\u0000${kind}\u0000${objectId}`;
}

function cursorEquals(left: InvestigationSyncCursorV1, right: InvestigationSyncCursorV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function conflict(
  code: SyncConflictCode,
  detail: string,
  operation: InvestigationSyncOperationV1 | null = null,
): SyncConflictV1 {
  return {
    code,
    operationId: operation?.operationId ?? null,
    sourceSequence: operation?.sourceSequence ?? null,
    objectKind: operation?.object.kind ?? null,
    objectId: operation?.object.objectId ?? null,
    detail,
  };
}

function sortConflicts(rows: SyncConflictV1[]): SyncConflictV1[] {
  return [...rows].sort((left, right) => {
    const leftSequence = left.sourceSequence ?? -1;
    const rightSequence = right.sourceSequence ?? -1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    const leftKey = `${left.code}\u0000${left.objectKind ?? ""}\u0000${left.objectId ?? ""}`;
    const rightKey = `${right.code}\u0000${right.objectKind ?? ""}\u0000${right.objectId ?? ""}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function parseInvestigationSyncDestinationState(
  raw: unknown,
): InvestigationSyncDestinationStateV1 {
  checkObject("$", destinationStateShape, raw);
  const state = raw as InvestigationSyncDestinationStateV1;
  assertNoCredentialLeakage(state);
  requireInstallationId("$.destinationInstallationId", state.destinationInstallationId);
  validateCursor("$.checkpoint", state.checkpoint);
  requireOpaqueId("$.investigationId", state.investigationId);
  if (state.acceptedPrivacyClasses.length === 0) {
    throw new ContractViolation("$.acceptedPrivacyClasses", "destination must accept at least one privacy class");
  }
  if (new Set(state.acceptedPrivacyClasses).size !== state.acceptedPrivacyClasses.length) {
    throw new ContractViolation("$.acceptedPrivacyClasses", "duplicate privacy class");
  }
  const objectIds = new Set<string>();
  for (const [index, object] of state.objects.entries()) {
    requireInstallationId(`$.objects[${index}].sourceInstallationId`, object.sourceInstallationId);
    requireOpaqueId(`$.objects[${index}].objectId`, object.objectId);
    const key = objectKey(object.sourceInstallationId, object.kind, object.objectId);
    if (objectIds.has(key)) throw new ContractViolation(`$.objects[${index}]`, "duplicate object state");
    objectIds.add(key);
    if (object.revision < 1) throw new ContractViolation(`$.objects[${index}].revision`, "must be >= 1");
    if (object.objectHash === null) {
      throw new ContractViolation(`$.objects[${index}].objectHash`, "live objects and tombstones require a hash");
    }
    requireSha256(`$.objects[${index}].objectHash`, object.objectHash);
  }
  const operationIds = new Set<string>();
  const sourceSequences = new Set<string>();
  for (const [index, operation] of state.appliedOperations.entries()) {
    requireOperationId(`$.appliedOperations[${index}].operationId`, operation.operationId);
    requireInstallationId(`$.appliedOperations[${index}].sourceInstallationId`, operation.sourceInstallationId);
    requireSha256(`$.appliedOperations[${index}].operationFingerprint`, operation.operationFingerprint);
    if (operation.sourceSequence < 1) throw new ContractViolation(`$.appliedOperations[${index}].sourceSequence`, "must be >= 1");
    if (operationIds.has(operation.operationId)) throw new ContractViolation(`$.appliedOperations[${index}].operationId`, "duplicate applied operation id");
    operationIds.add(operation.operationId);
    const key = `${operation.sourceInstallationId}\u0000${operation.sourceSequence}`;
    if (sourceSequences.has(key)) throw new ContractViolation(`$.appliedOperations[${index}].sourceSequence`, "duplicate source sequence");
    sourceSequences.add(key);
  }
  const checkpointOperations = state.appliedOperations.filter(
    (row) => row.sourceInstallationId === state.checkpoint.sourceInstallationId,
  );
  if (checkpointOperations.some((row) => row.sourceSequence > state.checkpoint.throughSequence)) {
    throw new ContractViolation("$.checkpoint", "applied operation exists beyond the checkpoint");
  }
  if (state.checkpoint.throughSequence > 0) {
    const tip = checkpointOperations.find(
      (row) => row.sourceSequence === state.checkpoint.throughSequence,
    );
    if (
      !tip ||
      tip.operationId !== state.checkpoint.lastOperationId ||
      tip.operationFingerprint !== state.checkpoint.lastOperationFingerprint
    ) {
      throw new ContractViolation("$.checkpoint", "checkpoint tip is not bound to applied operation history");
    }
  }
  return {
    ...state,
    checkpoint: { ...state.checkpoint },
    acceptedPrivacyClasses: [...state.acceptedPrivacyClasses].sort(),
    objects: [...state.objects].sort((a, b) => {
      const left = objectKey(a.sourceInstallationId, a.kind, a.objectId);
      const right = objectKey(b.sourceInstallationId, b.kind, b.objectId);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    appliedOperations: [...state.appliedOperations].sort((a, b) => {
      const left = `${a.sourceInstallationId}\u0000${String(a.sourceSequence).padStart(16, "0")}\u0000${a.operationId}`;
      const right = `${b.sourceInstallationId}\u0000${String(b.sourceSequence).padStart(16, "0")}\u0000${b.operationId}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}

export function investigationSyncDestinationStateFingerprint(
  state: InvestigationSyncDestinationStateV1,
): string {
  return sha256(canonicalJson(parseInvestigationSyncDestinationState(state)));
}

export function planInvestigationSync(
  batchRaw: unknown,
  destinationRaw: unknown,
): InvestigationSyncPlanV1 {
  const batch = parseInvestigationSyncBatch(batchRaw);
  const destination = parseInvestigationSyncDestinationState(destinationRaw);
  const conflicts: SyncConflictV1[] = [];
  const appliedById = new Map(
    destination.appliedOperations.map((row) => [
      `${row.sourceInstallationId}\u0000${row.operationId}`,
      row,
    ]),
  );
  const appliedBySequence = new Map(
    destination.appliedOperations.map((row) => [`${row.sourceInstallationId}\u0000${row.sourceSequence}`, row]),
  );
  const exactReplay = batch.operations.length > 0 && batch.operations.every((operation) => {
    const applied = appliedById.get(`${operation.sourceInstallationId}\u0000${operation.operationId}`);
    return applied?.operationFingerprint === operation.operationFingerprint;
  });

  if (destination.destinationInstallationId === batch.sourceInstallationId) {
    conflicts.push(conflict("source_loop", "source and destination installations must differ"));
  }
  if (destination.investigationId !== batch.investigationId) {
    throw new ContractViolation("$.investigationId", "destination and batch investigations must match");
  }
  if (destination.checkpoint.sourceInstallationId !== batch.sourceInstallationId) {
    throw new ContractViolation("$.checkpoint.sourceInstallationId", "checkpoint must track the batch source");
  }

  for (const operation of batch.operations) {
    const byId = appliedById.get(`${operation.sourceInstallationId}\u0000${operation.operationId}`);
    if (byId && byId.operationFingerprint !== operation.operationFingerprint) {
      conflicts.push(conflict("operation_identity_collision", "operation id was previously applied with different bytes", operation));
    }
    const bySequence = appliedBySequence.get(`${operation.sourceInstallationId}\u0000${operation.sourceSequence}`);
    if (bySequence && bySequence.operationId !== operation.operationId) {
      conflicts.push(conflict("source_sequence_collision", "source sequence was previously occupied by another operation", operation));
    }
  }

  if (!exactReplay && !cursorEquals(destination.checkpoint, batch.fromCursor)) {
    conflicts.push(conflict("cursor_mismatch", "destination checkpoint does not match batch fromCursor"));
  }
  const replayCount = batch.operations.filter((operation) =>
    appliedById.get(`${operation.sourceInstallationId}\u0000${operation.operationId}`)
      ?.operationFingerprint === operation.operationFingerprint,
  ).length;
  if (!exactReplay && replayCount > 0) {
    conflicts.push(conflict("partial_replay", "mixed replay and new operations require a new contiguous batch"));
  }

  if (!exactReplay && conflicts.length === 0) {
    const objects = new Map(
      destination.objects.map((row) => [
        objectKey(row.sourceInstallationId, row.kind, row.objectId),
        { ...row },
      ]),
    );
    for (const operation of batch.operations) {
      if (!destination.acceptedPrivacyClasses.includes(operation.object.privacyClass)) {
        conflicts.push(
          conflict(
            "privacy_class_not_accepted",
            "destination policy does not accept this privacy class",
            operation,
          ),
        );
        continue;
      }
      const key = objectKey(
        operation.sourceInstallationId,
        operation.object.kind,
        operation.object.objectId,
      );
      const current = objects.get(key);
      if (operation.object.baseRevision === 0) {
        if (current) {
          conflicts.push(conflict("object_already_exists", "create operation targets an existing object", operation));
          continue;
        }
      } else {
        if (!current) {
          conflicts.push(conflict("object_missing", "operation targets an unknown object", operation));
          continue;
        }
        if (current.revision !== operation.object.baseRevision) {
          conflicts.push(conflict("revision_conflict", "destination revision does not match operation baseRevision", operation));
          continue;
        }
        if (current.objectHash !== operation.object.baseHash) {
          conflicts.push(conflict("base_hash_conflict", "destination hash does not match operation baseHash", operation));
          continue;
        }
        if (current.privacyClass === "owner_only" && operation.object.privacyClass === "share_safe") {
          conflicts.push(conflict("privacy_widening", "sync cannot widen owner-only content to share-safe", operation));
          continue;
        }
        if (current.tombstoned && operation.mutation === "upsert") {
          conflicts.push(conflict("resurrection_forbidden", "V1 does not resurrect tombstoned objects", operation));
          continue;
        }
      }
      objects.set(key, {
        sourceInstallationId: operation.sourceInstallationId,
        kind: operation.object.kind,
        objectId: operation.object.objectId,
        revision: operation.object.resultRevision,
        objectHash: operation.object.resultHash,
        privacyClass: operation.object.privacyClass,
        tombstoned: operation.mutation === "tombstone",
      });
    }
  }

  const sortedConflicts = sortConflicts(conflicts);
  const outcome: InvestigationSyncPlanV1["outcome"] = sortedConflicts.length
    ? "blocked"
    : exactReplay || batch.operations.length === 0
      ? "replay"
      : "apply";
  const operations: PlannedSyncOperationV1[] = batch.operations.map((operation) => ({
    operationId: operation.operationId,
    sourceSequence: operation.sourceSequence,
    action: outcome === "blocked" ? "blocked" : outcome === "replay" ? "replay" : "apply",
  }));
  const destinationStateFingerprint = investigationSyncDestinationStateFingerprint(destination);
  const reportWithoutFingerprint: Omit<InvestigationSyncPlanV1, "planFingerprint"> = {
    schemaId: INVESTIGATION_SYNC_PLAN_SCHEMA_ID,
    mode: "dry_run",
    outcome,
    batchFingerprint: batch.batchFingerprint,
    sourceInstallationId: batch.sourceInstallationId,
    destinationInstallationId: destination.destinationInstallationId,
    investigationId: batch.investigationId,
    operations,
    conflicts: sortedConflicts,
    destinationStateFingerprint,
    checkpointBefore: { ...destination.checkpoint },
    checkpointAfter: outcome === "apply" ? { ...batch.toCursor } : { ...destination.checkpoint },
    applyAuthorized: false,
    automaticSync: false,
    networkingIncluded: false,
    credentialsTransferred: false,
    membershipGranted: false,
    rolesGranted: false,
    capabilitiesGranted: false,
    exclusions: INVESTIGATION_SYNC_EXCLUSIONS,
  };
  return {
    ...reportWithoutFingerprint,
    planFingerprint: sha256(canonicalJson(reportWithoutFingerprint)),
  };
}
