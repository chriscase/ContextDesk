/**
 * Fail-closed V1 contract for a full-fidelity portable War Room investigation
 * bundle. Pure JSON functions: no I/O, no database, no apply/import wiring.
 */
import { createHash } from "node:crypto";
import { CASE_SEVERITIES, CASE_STATUSES, PRIVACY_CLASSES } from "./case.js";
import { CONTRIBUTION_KINDS, HYPOTHESIS_STATUSES } from "./contribution.js";
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifact.js";
import {
  CORPUS_INTAKE_ORIGINS,
  parseCorpusIntakeBatch,
  type CorpusIntakeOrigin,
} from "./investigation-corpus-intake.js";
import { GOLD_ALIGNMENT_NOT_CORRECTNESS, GOLD_ALIGNMENT_STATUSES, GOLD_IS_HUMAN_BENCHMARK } from "./gold.js";
import { COMPLETENESS, EVIDENCE_VISIBILITY } from "./run.js";
import {
  DECISION_STATUSES,
  HELPFULNESS_DIMENSIONS,
  SNAPSHOT_LINEAGE_CLASSES,
} from "./experiment.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafeFingerprint, assertShareSafeTimestamp } from "./privacy.js";
import { SNAPSHOT_FAIRNESS_CLASSES } from "./snapshot.js";
import { SOURCE_KINDS, SOURCE_LIFECYCLES } from "./source.js";
import { TRIAGE_JOB_MODES } from "./triage-job.js";

export const PORTABLE_SCHEMA_ID = "cd-collab.investigation_portable.v1" as const;
export const PORTABLE_PREFLIGHT_SCHEMA_ID =
  "cd-collab.investigation_portable_preflight.v1" as const;
export const PORTABLE_PROTOCOL_VERSION = "cd.v1" as const;

export const PORTABLE_PERMISSION_CAVEAT =
  "Imported membership and roles are historical snapshots only. Destination permissions must be newly authorized and audited." as const;
export const PORTABLE_HISTORY_CAVEAT =
  "Imported history is immutable. Destination identity is never inferred from display name or email." as const;

export const PORTABLE_TERMINAL_TRIAGE_STATUSES = [
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type PortableTerminalTriageStatus =
  (typeof PORTABLE_TERMINAL_TRIAGE_STATUSES)[number];

export const IDENTITY_ACTIONS = [
  "map_existing",
  "provision_invite",
  "preserve_historical_external",
  "leave_unresolved",
] as const;
export type IdentityAction = (typeof IDENTITY_ACTIONS)[number];

export const COLLISION_POLICIES = ["fail", "remap_deterministic"] as const;
export type CollisionPolicy = (typeof COLLISION_POLICIES)[number];

export const CONTENT_INCLUSIONS = ["present", "omitted", "private", "redacted"] as const;
export type ContentInclusion = (typeof CONTENT_INCLUSIONS)[number];

export const RECONSTRUCTION_STATUSES = ["exact", "metadata_only", "blocked"] as const;
export type ReconstructionStatus = (typeof RECONSTRUCTION_STATUSES)[number];

export const RECONSTRUCTION_REASON_CODES = [
  "content_omitted",
  "content_private",
  "content_redacted",
  "missing_user",
  "id_collision",
  "declared_present_bytes_missing",
  "declared_present_digest_mismatch",
  "declared_present_length_mismatch",
  "blocking_identity_action",
] as const;
export type ReconstructionReasonCode = (typeof RECONSTRUCTION_REASON_CODES)[number];

export interface ReconstructionReasonV1 {
  code: ReconstructionReasonCode;
  path: string;
  detail: string;
}

/** SHA-256 over canonical bytes is integrity, not authenticity or source trust. */
export const PORTABLE_INTEGRITY_NOT_AUTHENTICITY =
  "SHA-256 canonical fingerprints prove integrity of contract bytes, not authenticity of a source." as const;

export const PORTABLE_DESTINATION_CATALOG_NOT_AUTHORIZATION =
  "Destination identity and object catalogs are host-authored inputs. They are never authorization. A later server must load and revalidate them; client-supplied catalogs cannot grant authority." as const;

export const PORTABLE_HISTORICAL_PARTICIPANTS_ATTRIBUTION_ONLY =
  "Historical participants and roles are attribution snapshots only. They never become destination membership, role, or capability grants." as const;

export const PROVIDER_KINDS = [
  "openai_compatible",
  "ollama",
  "xai_grok_build",
  "anthropic",
  "unknown",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PORTABLE_OBJECT_KINDS = [
  "investigation",
  "actor",
  "contribution",
  "evidence",
  "intake_batch",
  "content",
  "source",
  "imported_ai_run",
  "snapshot",
  "triage_job",
  "experiment",
  "helpfulness",
  "decision",
  "gold",
  "alignment",
  "discussion",
  "timeline",
  "audit",
  "attachment",
] as const;
export type PortableObjectKind = (typeof PORTABLE_OBJECT_KINDS)[number];

/** Workstream attempts are `${jobId}:${candidateId}`; job-level events are a bare job id. */
export function parsePortableTriageAttemptTarget(
  targetId: string,
): { jobId: string; candidateId: string } | null {
  const separator = targetId.indexOf(":");
  if (separator <= 0 || separator === targetId.length - 1) return null;
  return {
    jobId: targetId.slice(0, separator),
    candidateId: targetId.slice(separator + 1),
  };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const INSTALLATION_ID = /^inst-[a-z0-9]{8,64}$/;
const UNKNOWN_STATUS = "unknown" as const;
const SITUATION_TEXT_LIMIT = 12_000;
const SITUATION_QUESTION_LIMIT = 2_000;
const SITUATION_QUESTION_COUNT_LIMIT = 50;

const FORBIDDEN_KEY_RE =
  /^(?:api[_-]?key|authorization|credential|credentials|password|passwd|pwd|secret|token|access[_-]?key|private[_-]?key|endpoint|base[_-]?url|ldap|ldap[_-]?url|bind[_-]?dn|bind[_-]?password|gateway[_-]?url|gateway[_-]?host|gateway[_-]?secret)$/i;

const FORBIDDEN_VALUE_RE =
  /(?:ldap[s]?:\/\/|bearer\s+\S+|sk-[a-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|token)\s*[:=])/i;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}


/** RFC 4122 UUID (version 1-8, variant 10xx). Acceptable as a PostgreSQL UUID. */
export const RFC4122_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Imported comparison traces are `${experimentId}:${traceId}`; experiment-level events are a bare experiment id. */
export function parsePortableExperimentTraceTarget(
  targetId: string,
): { experimentId: string; traceId: string } | null {
  const separator = targetId.indexOf(":");
  if (separator <= 0 || separator === targetId.length - 1) return null;
  return {
    experimentId: targetId.slice(0, separator),
    traceId: targetId.slice(separator + 1),
  };
}

export function formatPortableExperimentTraceTarget(experimentId: string, traceId: string): string {
  const target = `${experimentId}:${traceId}`;
  if (!RFC4122_UUID_RE.test(experimentId) || !parsePortableExperimentTraceTarget(target)) {
    throw new ContractViolation("$", "malformed experiment trace target");
  }
  return target;
}

const RFC4122_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidBytes(uuid: string): Buffer {
  if (!RFC4122_UUID_RE.test(uuid)) {
    throw new ContractViolation("$", `expected RFC 4122 UUID, got ${uuid}`);
  }
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidV5(namespaceUuid: string, name: string): string {
  const hash = createHash("sha1")
    .update(uuidBytes(namespaceUuid))
    .update(name, "utf8")
    .digest();
  const version = hash.at(6);
  const variant = hash.at(8);
  if (version === undefined || variant === undefined) {
    throw new ContractViolation("$", "SHA-1 UUID materialization failed");
  }
  hash[6] = (version & 0x0f) | 0x50;
  hash[8] = (variant & 0x3f) | 0x80;
  return formatUuid(hash);
}

export const PORTABLE_REMAP_NAMESPACE_UUID = uuidV5(
  RFC4122_DNS_NAMESPACE,
  "cd-collab.investigation-portable.remap.v1",
);

export function isRfc4122Uuid(value: string): boolean {
  return RFC4122_UUID_RE.test(value);
}

export function portableDestinationUuid(
  sourceInstallationId: string,
  namespace: PortableObjectKind,
  sourceId: string,
  collisionCounter: number,
): string {
  return uuidV5(
    PORTABLE_REMAP_NAMESPACE_UUID,
    `${sourceInstallationId}:${namespace}:${sourceId}:${collisionCounter}`,
  );
}


function requireNonEmpty(path: string, value: string, detail = "must not be empty"): string {
  if (!value.trim()) {
    throw new ContractViolation(path, detail);
  }
  return value;
}

const DISALLOWED_IDENTIFIER_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];

function hasDisallowedIdentifierCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      DISALLOWED_IDENTIFIER_CODE_POINT_RANGES.some(
        ([start, end]) => codePoint >= start && codePoint <= end,
      )
    ) {
      return true;
    }
  }
  return false;
}

function requireSafeIdentifier(path: string, value: string): string {
  requireNonEmpty(path, value, "identifier must not be empty");
  if (hasDisallowedIdentifierCodePoint(value)) {
    throw new ContractViolation(path, "control or zero-width character in identifier");
  }
  return value;
}

/**
 * Locale-independent lexicographic ordering over ECMAScript UTF-16 code units.
 * Do not replace with localeCompare: portable fingerprints and remap reports
 * must not depend on the source or destination host's locale/ICU data.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertSafeIdentifiers(value: unknown, path = "$."): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeIdentifiers(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path === "$." ? `$.${key}` : `${path}.${key}`;
    if (typeof child === "string" && /id$/i.test(key)) {
      requireSafeIdentifier(childPath, child);
    } else if (
      Array.isArray(child) &&
      /(?:ids|refs|anchors)$/i.test(key) &&
      child.every((item) => typeof item === "string")
    ) {
      child.forEach((item, i) => requireSafeIdentifier(`${childPath}[${i}]`, item as string));
    } else if (key === "objectIds" && child && typeof child === "object") {
      for (const [namespace, ids] of Object.entries(child as Record<string, unknown>)) {
        if (Array.isArray(ids)) {
          ids.forEach((id, i) => {
            if (typeof id === "string") {
              requireSafeIdentifier(`${childPath}.${namespace}[${i}]`, id);
            }
          });
        }
      }
    }
    assertSafeIdentifiers(child, childPath);
  }
}

function requireSha256(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest");
  }
}

function requireContentDigest(
  contents: readonly { digest: string; inclusion: string }[],
  digest: string,
  path: string,
  requirePresent: boolean,
): void {
  requireSha256(path, digest);
  const content = contents.find((item) => item.digest === digest);
  if (!content) {
    throw new ContractViolation(path, "dangling content digest");
  }
  if (requirePresent && content.inclusion !== "present") {
    throw new ContractViolation(path, "missing required content");
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort(compareCodeUnits)) {
      out[key] = canonicalValue(row[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function parseOpaquePayloadJson(path: string, raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ContractViolation(path, "opaquePayloadJson must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContractViolation(path, "opaquePayloadJson must encode a JSON object");
  }
  assertNoCredentialLeakage(parsed, path);
  assertOpaqueTransportSafety(parsed, path);
  return canonicalJson(parsed);
}

function assertOpaqueTransportSafety(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (
      /\b[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
      /(?:^|[\s"'`(=:[\]{},])\/\/[a-z0-9._~-]+(?:[/:?#]|$)/i.test(value)
    ) {
      throw new ContractViolation(path, "opaque payload must not contain a live endpoint or URL");
    }
    if (
      /(?:^|[\s"'`(=:[\]{},])(?:\.\.?[\\/])+[^\s"'`<>]+/.test(value) ||
      /(?:^|[\s"'`(=:[\]{},])~[\\/][^\s"'`<>]+/.test(value) ||
      /(?:^|[\s"'`(=:[\]{},])\/(?!\/)[a-z0-9._~-]+(?:[\\/][^\s"'`<>]+)*/i.test(value) ||
      /\b[a-z]:[\\/][^\s"'`<>]*/i.test(value) ||
      /\\\\[a-z0-9._-]+\\/i.test(value)
    ) {
      throw new ContractViolation(path, "opaque payload must not contain a filesystem path");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertOpaqueTransportSafety(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertOpaqueTransportSafety(key, `${path}.${key}`);
    assertOpaqueTransportSafety(child, `${path}.${key}`);
  }
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenKey(key: string): boolean {
  if (FORBIDDEN_KEY_RE.test(key)) return true;
  const normalized = normalizedKey(key);
  return (
    normalized.includes("ldap") ||
    normalized.includes("endpoint") ||
    normalized === "baseurl" ||
    normalized === "binddn" ||
    normalized === "bindpassword"
  );
}

export function assertNoCredentialLeakage(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE_RE.test(value)) {
      throw new ContractViolation(path, "credential, token, secret, or live endpoint leakage");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoCredentialLeakage(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenKey(key)) {
      throw new ContractViolation(childPath, "forbidden credential or destination-capability key");
    }
    assertNoCredentialLeakage(child, childPath);
  }
}

function uniqueIds(path: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const [i, id] of ids.entries()) {
    requireSafeIdentifier(`${path}[${i}]`, id);
    if (seen.has(id)) {
      throw new ContractViolation(`${path}[${i}]`, "duplicate id");
    }
    seen.add(id);
  }
}

function sortBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => compareCodeUnits(key(a), key(b)));
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

const hashEntryShape: ObjectShape = {
  kind: f.req(f.en(...PORTABLE_OBJECT_KINDS)),
  id: f.req(f.str),
  hash: f.req(f.str),
};

const actorShape: ObjectShape = {
  sourceActorId: f.req(f.str),
  username: f.req(f.str),
  displayName: f.req(f.str),
  email: f.nul(f.str),
  roleNote: f.nul(f.str),
  objectHash: f.req(f.str),
};

const participantShape: ObjectShape = {
  sourceActorId: f.req(f.str),
  role: f.req(f.str),
};

const investigationShape: ObjectShape = {
  id: f.req(f.str),
  title: f.req(f.str),
  status: f.req(f.en(...CASE_STATUSES)),
  severity: f.req(f.en(...CASE_SEVERITIES)),
  legalHold: f.req(f.bool),
  retentionClass: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  problemStatement: f.req(f.str),
  affectedParties: f.req(f.str),
  impact: f.req(f.str),
  scope: f.req(f.str),
  openQuestions: f.req(f.arr(f.str)),
  situationVersion: f.req(f.u64),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  objectHash: f.req(f.str),
};

const contributionShape: ObjectShape = {
  id: f.req(f.str),
  kind: f.req(f.en(...CONTRIBUTION_KINDS)),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  tombstoned: f.req(f.bool),
  authorId: f.req(f.str),
  sourceId: f.req(f.str),
  createdAt: f.req(f.str),
  hypothesisStatus: f.nul(f.en(...HYPOTHESIS_STATUSES)),
  hypothesisLinks: f.opt(f.arr(f.obj({
    kind: f.req(f.en("artifact", "contribution")),
    id: f.req(f.str),
  }))),
  objectHash: f.req(f.str),
};

const evidenceShape: ObjectShape = {
  id: f.req(f.str),
  title: f.req(f.str),
  artifactKind: f.opt(f.en(...ARTIFACT_KINDS)),
  sourceId: f.opt(f.str),
  summaryContributionId: f.optNul(f.str),
  relativePath: f.optNul(f.str),
  intakeBatchId: f.optNul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  digest: f.req(f.str),
  inclusion: f.req(f.en(...CONTENT_INCLUSIONS)),
  contentType: f.nul(f.str),
  byteLength: f.req(f.u64),
  createdBy: f.req(f.str),
  createdAt: f.req(f.str),
  objectHash: f.req(f.str),
};

const intakeBatchShape: ObjectShape = {
  id: f.req(f.str),
  caseId: f.req(f.str),
  idempotencyKey: f.req(f.str),
  requestDigest: f.req(f.str),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  payloadJson: f.req(f.str),
};

const contentObjectShape: ObjectShape = {
  digest: f.req(f.str),
  byteLength: f.req(f.u64),
  contentType: f.nul(f.str),
  inclusion: f.req(f.en(...CONTENT_INCLUSIONS)),
  payloadBase64: f.nul(f.str),
  objectHash: f.req(f.str),
};

const sourceShape: ObjectShape = {
  id: f.req(f.str),
  name: f.req(f.str),
  kind: f.req(f.en(...SOURCE_KINDS)),
  lifecycle: f.req(f.en(...SOURCE_LIFECYCLES)),
  identityId: f.nul(f.str),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  objectHash: f.req(f.str),
};

const importedRunShape: ObjectShape = {
  id: f.req(f.str),
  sourceId: f.req(f.str),
  importedAt: f.req(f.str),
  providerKind: f.req(f.en(...PROVIDER_KINDS)),
  model: f.req(f.str),
  version: f.nul(f.str),
  profileId: f.nul(f.str),
  usageStatus: f.req(f.en(UNKNOWN_STATUS)),
  costStatus: f.req(f.en(UNKNOWN_STATUS)),
  outputDigest: f.nul(f.str),
  contributionId: f.opt(f.str),
  promptDigest: f.optNul(f.str),
  promptCompleteness: f.opt(f.en(...COMPLETENESS)),
  outputCompleteness: f.opt(f.en(...COMPLETENESS)),
  workflowCompleteness: f.opt(f.en(...COMPLETENESS)),
  evidenceVisibility: f.opt(f.en(...EVIDENCE_VISIBILITY)),
  snapshotId: f.optNul(f.str),
  privacyClass: f.opt(f.en(...PRIVACY_CLASSES)),
  importerId: f.opt(f.str),
  operatorId: f.opt(f.str),
  claimedTraces: f.opt(f.arr(f.str)),
  visibilityNote: f.optNul(f.str),
  uncertainty: f.optNul(f.str),
  timing: f.optNul(f.str),
  cost: f.optNul(f.str),
  redacted: f.opt(f.bool),
  opaquePayloadJson: f.nul(f.str),
  objectHash: f.req(f.str),
};

const snapshotEvidenceShape: ObjectShape = {
  evidenceId: f.req(f.str),
  ordinal: f.req(f.u64),
  contentHash: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

const snapshotShape: ObjectShape = {
  id: f.req(f.str),
  fingerprint: f.req(f.str),
  parentSnapshotId: f.nul(f.str),
  fairnessClass: f.req(f.en(...SNAPSHOT_FAIRNESS_CLASSES)),
  lineageClass: f.req(f.en(...SNAPSHOT_LINEAGE_CLASSES)),
  visibility: f.req(f.en(...PRIVACY_CLASSES)),
  protocolVersion: f.req(f.str),
  evidence: f.req(f.arr(f.obj(snapshotEvidenceShape))),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  objectHash: f.req(f.str),
};

const triageCandidateShape: ObjectShape = {
  candidateId: f.req(f.str),
  role: f.req(f.str),
  providerKind: f.req(f.en(...PROVIDER_KINDS)),
  profileId: f.nul(f.str),
  model: f.req(f.str),
  version: f.nul(f.str),
  usageStatus: f.req(f.en(UNKNOWN_STATUS)),
  costStatus: f.req(f.en(UNKNOWN_STATUS)),
  outputHash: f.nul(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  status: f.opt(f.en(...PORTABLE_TERMINAL_TRIAGE_STATUSES)),
  benchmarkRunId: f.optNul(f.str),
  summary: f.optNul(f.str),
  unknowns: f.opt(f.arr(f.str)),
  errorCode: f.optNul(f.str),
  startedAt: f.optNul(f.str),
  finishedAt: f.optNul(f.str),
  privacyClass: f.opt(f.en(...PRIVACY_CLASSES)),
};

const triageJobShape: ObjectShape = {
  id: f.req(f.str),
  snapshotId: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  strategyId: f.req(f.str),
  status: f.req(f.en(...PORTABLE_TERMINAL_TRIAGE_STATUSES)),
  parentJobId: f.nul(f.str),
  requestFingerprint: f.req(f.str),
  candidates: f.req(f.arr(f.obj(triageCandidateShape))),
  requestedBy: f.req(f.str),
  createdAt: f.req(f.str),
  requestMode: f.opt(f.en(...TRIAGE_JOB_MODES)),
  question: f.opt(f.str),
  policyFingerprint: f.optNul(f.str),
  taskFingerprint: f.opt(f.str),
  concurrency: f.optNul(f.u64),
  sameSnapshot: f.optNul(f.bool),
  agreementNotice: f.opt(f.en("Agreement is not proof of correctness.")),
  updatedAt: f.opt(f.str),
  startedAt: f.optNul(f.str),
  finishedAt: f.optNul(f.str),
  cancelRequestedAt: f.optNul(f.str),
  stoppedReason: f.optNul(f.str),
  objectHash: f.req(f.str),
};

const experimentShape: ObjectShape = {
  id: f.req(f.str),
  packageId: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  taskFingerprint: f.req(f.str),
  candidateIds: f.req(f.arr(f.str)),
  createdAt: f.req(f.str),
  importerId: f.opt(f.str),
  objectHash: f.req(f.str),
};

const helpfulnessShape: ObjectShape = {
  id: f.req(f.str),
  experimentId: f.req(f.str),
  candidateId: f.req(f.str),
  dimension: f.req(f.en(...HELPFULNESS_DIMENSIONS)),
  score: f.req(f.u64),
  rationale: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  reviewerId: f.req(f.str),
  createdAt: f.req(f.str),
  objectHash: f.req(f.str),
};

const decisionShape: ObjectShape = {
  id: f.req(f.str),
  experimentId: f.req(f.str),
  status: f.req(f.en(...DECISION_STATUSES)),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  text: f.req(f.str),
  rationale: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  authorId: f.req(f.str),
  ownerId: f.optNul(f.str),
  remainingUnknowns: f.opt(f.arr(f.str)),
  createdAt: f.req(f.str),
  objectHash: f.req(f.str),
};

const goldShape: ObjectShape = {
  goldId: f.req(f.str),
  version: f.req(f.u64),
  predecessorGoldId: f.nul(f.str),
  experimentId: f.req(f.str),
  acceptedDecisionId: f.req(f.str),
  acceptedDecisionRevision: f.req(f.u64),
  evidenceAnchors: f.req(f.arr(f.str)),
  notes: f.req(f.arr(f.str)),
  promotedById: f.req(f.str),
  createdAt: f.req(f.str),
  objectHash: f.req(f.str),
};

const alignmentShape: ObjectShape = {
  id: f.req(f.str),
  goldId: f.req(f.str),
  candidateId: f.req(f.str),
  status: f.req(f.en(...GOLD_ALIGNMENT_STATUSES)),
  matchedAnchors: f.req(f.arr(f.str)),
  missingAnchors: f.req(f.arr(f.str)),
  extraAnchors: f.req(f.arr(f.str)),
  notes: f.req(f.arr(f.str)),
  objectHash: f.req(f.str),
};

const discussionShape: ObjectShape = {
  id: f.req(f.str),
  title: f.req(f.str),
  authorId: f.req(f.str),
  createdAt: f.req(f.str),
  messageIds: f.req(f.arr(f.str)),
  objectHash: f.req(f.str),
};

const timelineShape: ObjectShape = {
  seq: f.req(f.u64),
  kind: f.req(f.str),
  actorId: f.req(f.str),
  targetId: f.nul(f.str),
  targetNamespace: f.nul(f.str),
  serverTime: f.req(f.str),
  objectHash: f.req(f.str),
};

const auditShape: ObjectShape = {
  id: f.req(f.str),
  kind: f.req(f.str),
  actorId: f.req(f.str),
  createdAt: f.req(f.str),
  summaryHash: f.req(f.str),
  objectHash: f.req(f.str),
};

const attachmentShape: ObjectShape = {
  id: f.req(f.str),
  discussionId: f.nul(f.str),
  evidenceId: f.req(f.str),
  digest: f.req(f.str),
  inclusion: f.req(f.en(...CONTENT_INCLUSIONS)),
  objectHash: f.req(f.str),
};

const bundleShape: ObjectShape = {
  schemaId: f.req(f.en(PORTABLE_SCHEMA_ID)),
  protocolVersion: f.req(f.en(PORTABLE_PROTOCOL_VERSION)),
  sourceInstallationId: f.req(f.str),
  exportedAt: f.req(f.str),
  bundleFingerprint: f.req(f.str),
  permissionCaveat: f.req(f.en(PORTABLE_PERMISSION_CAVEAT)),
  historyCaveat: f.req(f.en(PORTABLE_HISTORY_CAVEAT)),
  objectHashes: f.req(f.arr(f.obj(hashEntryShape))),
  investigation: f.req(f.obj(investigationShape)),
  actors: f.req(f.arr(f.obj(actorShape))),
  participants: f.req(f.arr(f.obj(participantShape))),
  contributions: f.req(f.arr(f.obj(contributionShape))),
  evidence: f.req(f.arr(f.obj(evidenceShape))),
  intakeBatches: f.opt(f.arr(f.obj(intakeBatchShape))),
  contentObjects: f.req(f.arr(f.obj(contentObjectShape))),
  sources: f.req(f.arr(f.obj(sourceShape))),
  importedAiRuns: f.req(f.arr(f.obj(importedRunShape))),
  snapshots: f.req(f.arr(f.obj(snapshotShape))),
  triageJobs: f.req(f.arr(f.obj(triageJobShape))),
  experiments: f.req(f.arr(f.obj(experimentShape))),
  helpfulnessObservations: f.req(f.arr(f.obj(helpfulnessShape))),
  decisions: f.req(f.arr(f.obj(decisionShape))),
  gold: f.req(f.arr(f.obj(goldShape))),
  alignments: f.req(f.arr(f.obj(alignmentShape))),
  discussions: f.req(f.arr(f.obj(discussionShape))),
  timeline: f.req(f.arr(f.obj(timelineShape))),
  auditRefs: f.req(f.arr(f.obj(auditShape))),
  attachments: f.req(f.arr(f.obj(attachmentShape))),
};

export interface PortableHashEntryV1 {
  kind: PortableObjectKind;
  id: string;
  hash: string;
}

export interface PortableActorV1 {
  sourceActorId: string;
  username: string;
  displayName: string;
  email: string | null;
  roleNote: string | null;
  objectHash: string;
}

export interface PortableParticipantV1 {
  sourceActorId: string;
  role: string;
}

export interface PortableInvestigationMetaV1 {
  id: string;
  title: string;
  status: (typeof CASE_STATUSES)[number];
  severity: (typeof CASE_SEVERITIES)[number];
  legalHold: boolean;
  retentionClass: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  openQuestions: string[];
  situationVersion: number;
  createdAt: string;
  createdBy: string;
  objectHash: string;
}

export interface PortableContributionV1 {
  id: string;
  kind: (typeof CONTRIBUTION_KINDS)[number];
  revision: number;
  predecessorRevision: number | null;
  body: string | null;
  contentHash: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  tombstoned: boolean;
  authorId: string;
  sourceId: string;
  createdAt: string;
  hypothesisStatus: (typeof HYPOTHESIS_STATUSES)[number] | null;
  hypothesisLinks?: { kind: "artifact" | "contribution"; id: string }[];
  objectHash: string;
}

export interface PortableEvidenceV1 {
  id: string;
  title: string;
  artifactKind?: ArtifactKind;
  sourceId?: string;
  summaryContributionId?: string | null;
  relativePath?: string | null;
  intakeBatchId?: string | null;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  digest: string;
  inclusion: ContentInclusion;
  contentType: string | null;
  byteLength: number;
  createdBy: string;
  createdAt: string;
  objectHash: string;
}

export interface PortableIntakeBatchV1 {
  id: string;
  caseId: string;
  idempotencyKey: string;
  requestDigest: string;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  createdAt: string;
  createdBy: string;
  payloadJson: string;
}

export interface PortableContentObjectV1 {
  digest: string;
  byteLength: number;
  contentType: string | null;
  inclusion: ContentInclusion;
  payloadBase64: string | null;
  objectHash: string;
}

export interface PortableSourceV1 {
  id: string;
  name: string;
  kind: (typeof SOURCE_KINDS)[number];
  lifecycle: (typeof SOURCE_LIFECYCLES)[number];
  identityId: string | null;
  createdAt: string;
  createdBy: string;
  objectHash: string;
}

export interface PortableImportedAiRunV1 {
  id: string;
  sourceId: string;
  importedAt: string;
  providerKind: ProviderKind;
  model: string;
  version: string | null;
  profileId: string | null;
  usageStatus: "unknown";
  costStatus: "unknown";
  outputDigest: string | null;
  contributionId?: string;
  promptDigest?: string | null;
  promptCompleteness?: (typeof COMPLETENESS)[number];
  outputCompleteness?: (typeof COMPLETENESS)[number];
  workflowCompleteness?: (typeof COMPLETENESS)[number];
  evidenceVisibility?: (typeof EVIDENCE_VISIBILITY)[number];
  snapshotId?: string | null;
  privacyClass?: (typeof PRIVACY_CLASSES)[number];
  importerId?: string;
  operatorId?: string;
  claimedTraces?: string[];
  visibilityNote?: string | null;
  uncertainty?: string | null;
  timing?: string | null;
  cost?: string | null;
  redacted?: boolean;
  opaquePayloadJson: string | null;
  objectHash: string;
}

export interface PortableSnapshotEvidenceV1 {
  evidenceId: string;
  ordinal: number;
  contentHash: string | null;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
}

export interface PortableSnapshotV1 {
  id: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  fairnessClass: (typeof SNAPSHOT_FAIRNESS_CLASSES)[number];
  lineageClass: (typeof SNAPSHOT_LINEAGE_CLASSES)[number];
  visibility: (typeof PRIVACY_CLASSES)[number];
  protocolVersion: string;
  evidence: PortableSnapshotEvidenceV1[];
  createdAt: string;
  createdBy: string;
  objectHash: string;
}

export interface PortableTriageCandidateV1 {
  candidateId: string;
  role: string;
  providerKind: ProviderKind;
  profileId: string | null;
  model: string;
  version: string | null;
  usageStatus: "unknown";
  costStatus: "unknown";
  outputHash: string | null;
  evidenceRefs: string[];
  /** Optional only so older V1 archives can be inspected; exact apply requires every field below. */
  status?: PortableTerminalTriageStatus;
  benchmarkRunId?: string | null;
  summary?: string | null;
  unknowns?: string[];
  errorCode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  privacyClass?: (typeof PRIVACY_CLASSES)[number];
}

export interface PortableTriageJobV1 {
  id: string;
  snapshotId: string;
  snapshotFingerprint: string;
  strategyId: string;
  status: PortableTerminalTriageStatus;
  parentJobId: string | null;
  requestFingerprint: string;
  candidates: PortableTriageCandidateV1[];
  requestedBy: string;
  createdAt: string;
  /** Optional only so older V1 archives can be inspected; exact apply requires every field below. */
  requestMode?: (typeof TRIAGE_JOB_MODES)[number];
  question?: string;
  policyFingerprint?: string | null;
  taskFingerprint?: string;
  concurrency?: number | null;
  sameSnapshot?: boolean | null;
  agreementNotice?: "Agreement is not proof of correctness.";
  updatedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
  stoppedReason?: string | null;
  objectHash: string;
}

export interface PortableExperimentV1 {
  id: string;
  packageId: string;
  snapshotFingerprint: string;
  taskFingerprint: string;
  candidateIds: string[];
  createdAt: string;
  importerId?: string;
  objectHash: string;
}

export interface PortableHelpfulnessV1 {
  id: string;
  experimentId: string;
  candidateId: string;
  dimension: (typeof HELPFULNESS_DIMENSIONS)[number];
  score: number;
  rationale: string;
  evidenceRefs: string[];
  reviewerId: string;
  createdAt: string;
  objectHash: string;
}

export interface PortableDecisionV1 {
  id: string;
  experimentId: string;
  status: (typeof DECISION_STATUSES)[number];
  revision: number;
  predecessorRevision: number | null;
  text: string;
  rationale: string;
  evidenceRefs: string[];
  authorId: string;
  /** Optional for V1 compatibility; new bundles write null for an unassigned owner. */
  ownerId?: string | null;
  /** Durable open questions recorded with this decision revision. */
  remainingUnknowns?: string[];
  createdAt: string;
  objectHash: string;
}

export interface PortableGoldV1 {
  goldId: string;
  version: number;
  predecessorGoldId: string | null;
  experimentId: string;
  acceptedDecisionId: string;
  acceptedDecisionRevision: number;
  evidenceAnchors: string[];
  notes: string[];
  promotedById: string;
  createdAt: string;
  objectHash: string;
}

export interface PortableAlignmentV1 {
  id: string;
  goldId: string;
  candidateId: string;
  status: (typeof GOLD_ALIGNMENT_STATUSES)[number];
  matchedAnchors: string[];
  missingAnchors: string[];
  extraAnchors: string[];
  notes: string[];
  objectHash: string;
}

export interface PortableDiscussionV1 {
  id: string;
  title: string;
  authorId: string;
  createdAt: string;
  messageIds: string[];
  objectHash: string;
}

export interface PortableTimelineRefV1 {
  seq: number;
  kind: string;
  actorId: string;
  targetId: string | null;
  targetNamespace: string | null;
  serverTime: string;
  objectHash: string;
}

export interface PortableAuditRefV1 {
  id: string;
  kind: string;
  actorId: string;
  createdAt: string;
  summaryHash: string;
  objectHash: string;
}

export interface PortableAttachmentV1 {
  id: string;
  discussionId: string | null;
  evidenceId: string;
  digest: string;
  inclusion: ContentInclusion;
  objectHash: string;
}

export interface PortableInvestigationV1 {
  schemaId: typeof PORTABLE_SCHEMA_ID;
  protocolVersion: typeof PORTABLE_PROTOCOL_VERSION;
  sourceInstallationId: string;
  exportedAt: string;
  bundleFingerprint: string;
  permissionCaveat: typeof PORTABLE_PERMISSION_CAVEAT;
  historyCaveat: typeof PORTABLE_HISTORY_CAVEAT;
  objectHashes: PortableHashEntryV1[];
  investigation: PortableInvestigationMetaV1;
  actors: PortableActorV1[];
  participants: PortableParticipantV1[];
  contributions: PortableContributionV1[];
  evidence: PortableEvidenceV1[];
  intakeBatches?: PortableIntakeBatchV1[];
  contentObjects: PortableContentObjectV1[];
  sources: PortableSourceV1[];
  importedAiRuns: PortableImportedAiRunV1[];
  snapshots: PortableSnapshotV1[];
  triageJobs: PortableTriageJobV1[];
  experiments: PortableExperimentV1[];
  helpfulnessObservations: PortableHelpfulnessV1[];
  decisions: PortableDecisionV1[];
  gold: PortableGoldV1[];
  alignments: PortableAlignmentV1[];
  discussions: PortableDiscussionV1[];
  timeline: PortableTimelineRefV1[];
  auditRefs: PortableAuditRefV1[];
  attachments: PortableAttachmentV1[];
}

export type PortableInvestigationUnsigned = Omit<
  PortableInvestigationV1,
  "bundleFingerprint" | "objectHashes"
> & {
  bundleFingerprint?: string;
  objectHashes?: PortableHashEntryV1[];
};

function stripHash<T extends { objectHash?: string }>(row: T): Omit<T, "objectHash"> {
  const copy = { ...row };
  delete copy.objectHash;
  return copy;
}

function hashObject(kind: PortableObjectKind, id: string, body: unknown): PortableHashEntryV1 {
  return { kind, id, hash: sha256Text(canonicalJson(body)) };
}

function sortPortableBags(bundle: PortableInvestigationUnsigned): PortableInvestigationUnsigned {
  return {
    ...bundle,
    actors: sortBy(bundle.actors, (row) => row.sourceActorId),
    participants: sortBy(bundle.participants, (row) => row.sourceActorId),
    contributions: sortBy(bundle.contributions, (row) => `${row.id}:${row.revision}`),
    evidence: sortBy(bundle.evidence, (row) => row.id),
    ...(bundle.intakeBatches
      ? { intakeBatches: sortBy(bundle.intakeBatches, (row) => row.id) }
      : {}),
    contentObjects: sortBy(bundle.contentObjects, (row) => row.digest),
    sources: sortBy(bundle.sources, (row) => row.id),
    importedAiRuns: sortBy(bundle.importedAiRuns, (row) => row.id),
    snapshots: sortBy(bundle.snapshots, (row) => row.id).map((snap) => ({
      ...snap,
      evidence: sortBy(snap.evidence, (item) => item.evidenceId),
    })),
    triageJobs: sortBy(bundle.triageJobs, (row) => row.id).map((job) => ({
      ...job,
      candidates: sortBy(job.candidates, (item) => item.candidateId),
    })),
    experiments: sortBy(bundle.experiments, (row) => row.id),
    helpfulnessObservations: sortBy(bundle.helpfulnessObservations, (row) => row.id),
    decisions: sortBy(bundle.decisions, (row) => `${row.id}:${row.revision}`),
    gold: sortBy(bundle.gold, (row) => `${row.goldId}:${row.version}`),
    alignments: sortBy(bundle.alignments, (row) => row.id),
    discussions: sortBy(bundle.discussions, (row) => row.id),
    timeline: sortBy(bundle.timeline, (row) => String(row.seq).padStart(16, "0")),
    auditRefs: sortBy(bundle.auditRefs, (row) => row.id),
    attachments: sortBy(bundle.attachments, (row) => row.id),
  };
}

export function portableSnapshotFingerprint(
  snap: Pick<
    PortableSnapshotV1,
    "parentSnapshotId" | "evidence" | "visibility" | "protocolVersion"
  >,
): string {
  return sha256Text(
    canonicalJson({
      parentSnapshotId: snap.parentSnapshotId,
      evidence: sortBy(snap.evidence, (item) => item.evidenceId),
      visibility: snap.visibility,
      protocolVersion: snap.protocolVersion,
    }),
  );
}

export function computePortableObjectHashes(
  bundle: PortableInvestigationUnsigned,
): PortableHashEntryV1[] {
  const sorted = sortPortableBags(bundle);
  const hashes: PortableHashEntryV1[] = [
    hashObject("investigation", sorted.investigation.id, stripHash(sorted.investigation)),
    ...sorted.actors.map((row) => hashObject("actor", row.sourceActorId, stripHash(row))),
    ...sorted.contributions.map((row) =>
      hashObject("contribution", `${row.id}:${row.revision}`, stripHash(row)),
    ),
    ...sorted.evidence.map((row) => hashObject("evidence", row.id, stripHash(row))),
    ...sorted.contentObjects.map((row) => hashObject("content", row.digest, stripHash(row))),
    ...sorted.sources.map((row) => hashObject("source", row.id, stripHash(row))),
    ...sorted.importedAiRuns.map((row) => hashObject("imported_ai_run", row.id, stripHash(row))),
    ...sorted.snapshots.map((row) => hashObject("snapshot", row.id, stripHash(row))),
    ...sorted.triageJobs.map((row) => hashObject("triage_job", row.id, stripHash(row))),
    ...sorted.experiments.map((row) => hashObject("experiment", row.id, stripHash(row))),
    ...sorted.helpfulnessObservations.map((row) =>
      hashObject("helpfulness", row.id, stripHash(row)),
    ),
    ...sorted.decisions.map((row) =>
      hashObject("decision", `${row.id}:${row.revision}`, stripHash(row)),
    ),
    ...sorted.gold.map((row) => hashObject("gold", `${row.goldId}:${row.version}`, stripHash(row))),
    ...sorted.alignments.map((row) => hashObject("alignment", row.id, stripHash(row))),
    ...sorted.discussions.map((row) => hashObject("discussion", row.id, stripHash(row))),
    ...sorted.timeline.map((row) => hashObject("timeline", String(row.seq), stripHash(row))),
    ...sorted.auditRefs.map((row) => hashObject("audit", row.id, stripHash(row))),
    ...sorted.attachments.map((row) => hashObject("attachment", row.id, stripHash(row))),
  ];
  return sortBy(hashes, (row) => `${row.kind}:${row.id}`);
}

export function portableBundleFingerprint(bundle: PortableInvestigationUnsigned): string {
  const sorted = sortPortableBags(bundle);
  const objectHashes = computePortableObjectHashes(sorted);
  const { bundleFingerprint: _ignored, ...rest } = {
    ...sorted,
    objectHashes,
  };
  return sha256Text(canonicalJson(rest));
}

function hashMap(entries: PortableHashEntryV1[]): Map<string, string> {
  return new Map(entries.map((row) => [`${row.kind}:${row.id}`, row.hash]));
}

function applyPerObjectHashes(
  bundle: PortableInvestigationUnsigned,
  hashes: PortableHashEntryV1[],
): PortableInvestigationUnsigned {
  const map = hashMap(hashes);
  const take = (kind: PortableObjectKind, id: string): string => {
    const hash = map.get(`${kind}:${id}`);
    if (!hash) {
      throw new ContractViolation("$", `missing object hash for ${kind}:${id}`);
    }
    return hash;
  };
  return {
    ...bundle,
    investigation: {
      ...bundle.investigation,
      objectHash: take("investigation", bundle.investigation.id),
    },
    actors: bundle.actors.map((row) => ({
      ...row,
      objectHash: take("actor", row.sourceActorId),
    })),
    contributions: bundle.contributions.map((row) => ({
      ...row,
      objectHash: take("contribution", `${row.id}:${row.revision}`),
    })),
    evidence: bundle.evidence.map((row) => ({
      ...row,
      objectHash: take("evidence", row.id),
    })),
    contentObjects: bundle.contentObjects.map((row) => ({
      ...row,
      objectHash: take("content", row.digest),
    })),
    sources: bundle.sources.map((row) => ({
      ...row,
      objectHash: take("source", row.id),
    })),
    importedAiRuns: bundle.importedAiRuns.map((row) => ({
      ...row,
      objectHash: take("imported_ai_run", row.id),
    })),
    snapshots: bundle.snapshots.map((row) => ({
      ...row,
      objectHash: take("snapshot", row.id),
    })),
    triageJobs: bundle.triageJobs.map((row) => ({
      ...row,
      objectHash: take("triage_job", row.id),
    })),
    experiments: bundle.experiments.map((row) => ({
      ...row,
      objectHash: take("experiment", row.id),
    })),
    helpfulnessObservations: bundle.helpfulnessObservations.map((row) => ({
      ...row,
      objectHash: take("helpfulness", row.id),
    })),
    decisions: bundle.decisions.map((row) => ({
      ...row,
      objectHash: take("decision", `${row.id}:${row.revision}`),
    })),
    gold: bundle.gold.map((row) => ({
      ...row,
      objectHash: take("gold", `${row.goldId}:${row.version}`),
    })),
    alignments: bundle.alignments.map((row) => ({
      ...row,
      objectHash: take("alignment", row.id),
    })),
    discussions: bundle.discussions.map((row) => ({
      ...row,
      objectHash: take("discussion", row.id),
    })),
    timeline: bundle.timeline.map((row) => ({
      ...row,
      objectHash: take("timeline", String(row.seq)),
    })),
    auditRefs: bundle.auditRefs.map((row) => ({
      ...row,
      objectHash: take("audit", row.id),
    })),
    attachments: bundle.attachments.map((row) => ({
      ...row,
      objectHash: take("attachment", row.id),
    })),
  };
}

export function attachPortableIntegrity(
  bundle: PortableInvestigationUnsigned,
): PortableInvestigationV1 {
  const sorted = sortPortableBags(bundle);
  const objectHashes = computePortableObjectHashes(sorted);
  const withFields = applyPerObjectHashes(sorted, objectHashes);
  const withHashes = { ...withFields, objectHashes };
  return {
    ...withHashes,
    schemaId: PORTABLE_SCHEMA_ID,
    protocolVersion: PORTABLE_PROTOCOL_VERSION,
    bundleFingerprint: portableBundleFingerprint(withHashes),
    objectHashes,
  } as PortableInvestigationV1;
}

export function canonicalizePortableInvestigation(
  bundle: PortableInvestigationV1,
): PortableInvestigationV1 {
  const { bundleFingerprint: _fp, objectHashes: _hashes, ...rest } = bundle;
  return attachPortableIntegrity(rest);
}

function assertVersionChain(
  path: string,
  rows: { id: string; revision: number; predecessorRevision: number | null }[],
): void {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.id) ?? [];
    list.push(row);
    grouped.set(row.id, list);
  }
  for (const [id, chain] of grouped) {
    const ordered = [...chain].sort((a, b) => a.revision - b.revision);
    const seen = new Set<number>();
    for (const [i, row] of ordered.entries()) {
      if (row.revision < 1) {
        throw new ContractViolation(`${path} id=${id}`, "revision must be >= 1");
      }
      if (seen.has(row.revision)) {
        throw new ContractViolation(`${path} id=${id}`, "corrupt version chain: duplicate revision");
      }
      seen.add(row.revision);
      if (i === 0) {
        if (row.revision !== 1 || row.predecessorRevision !== null) {
          throw new ContractViolation(
            `${path} id=${id}`,
            "corrupt version chain: revision 1 must have null predecessor",
          );
        }
      } else {
        const prev = ordered[i - 1];
        if (
          !prev ||
          row.revision !== prev.revision + 1 ||
          row.predecessorRevision !== prev.revision
        ) {
          throw new ContractViolation(`${path} id=${id}`, "corrupt version chain");
        }
      }
    }
  }
}

function detectSnapshotCycles(snapshots: PortableSnapshotV1[]): void {
  const parent = new Map<string, string | null>();
  for (const snap of snapshots) {
    if (snap.parentSnapshotId === snap.id) {
      throw new ContractViolation(`$.snapshots id=${snap.id}`, "self/cyclic lineage");
    }
    parent.set(snap.id, snap.parentSnapshotId);
  }
  for (const snap of snapshots) {
    const seen = new Set<string>();
    let cursor: string | null = snap.id;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ContractViolation(`$.snapshots id=${snap.id}`, "self/cyclic lineage");
      }
      seen.add(cursor);
      cursor = parent.get(cursor) ?? null;
      if (cursor && !parent.has(cursor)) {
        throw new ContractViolation(`$.snapshots id=${snap.id}`, "dangling parent snapshot");
      }
    }
    if (snap.lineageClass === "root" && snap.parentSnapshotId !== null) {
      throw new ContractViolation(`$.snapshots id=${snap.id}`, "root lineage cannot name a parent");
    }
    if (snap.lineageClass === "derived" && snap.parentSnapshotId === null) {
      throw new ContractViolation(`$.snapshots id=${snap.id}`, "derived lineage requires a parent");
    }
  }
}

function requireActor(
  actors: Map<string, PortableActorV1>,
  actorId: string,
  path: string,
): void {
  if (!actors.has(actorId)) {
    throw new ContractViolation(path, "dangling actor reference");
  }
}

function validateContent(
  bundle: PortableInvestigationV1,
  options: ParsePortableInvestigationOptions = {},
): void {
  const contents = new Map(bundle.contentObjects.map((row) => [row.digest, row]));
  uniqueIds(
    "$.contentObjects.digest",
    bundle.contentObjects.map((row) => row.digest),
  );
  for (const [i, row] of bundle.contentObjects.entries()) {
    requireSha256(`$.contentObjects[${i}].digest`, row.digest);
    requireSha256(`$.contentObjects[${i}].objectHash`, row.objectHash);
    if (row.inclusion === "present") {
      if (row.payloadBase64 === null) {
        if (options.requireInlinePresentPayload !== false) {
          throw new ContractViolation(
            `$.contentObjects[${i}].payloadBase64`,
            "missing required content",
          );
        }
      } else {
      const bytes = Buffer.from(row.payloadBase64, "base64");
      if (bytes.byteLength !== row.byteLength) {
        throw new ContractViolation(`$.contentObjects[${i}].byteLength`, "payload length mismatch");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== row.digest) {
        throw new ContractViolation(`$.contentObjects[${i}].digest`, "hash/fingerprint mismatch");
      }
      }
    } else if (row.payloadBase64 !== null) {
      throw new ContractViolation(
        `$.contentObjects[${i}].payloadBase64`,
        "omitted, private, or redacted content must not include payload",
      );
    }
  }
  for (const [i, ev] of bundle.evidence.entries()) {
    requireSha256(`$.evidence[${i}].digest`, ev.digest);
    const content = contents.get(ev.digest);
    if (!content) {
      throw new ContractViolation(`$.evidence[${i}].digest`, "dangling content digest");
    }
    if (ev.inclusion === "present" && content.inclusion !== "present") {
      throw new ContractViolation(`$.evidence[${i}].inclusion`, "missing required content");
    }
    if (ev.privacyClass === "share_safe" && ev.inclusion === "private") {
      throw new ContractViolation(
        `$.evidence[${i}].inclusion`,
        "illegal privacy claim: share-safe evidence cannot be private",
      );
    }
    if (ev.privacyClass === "owner_only" && ev.inclusion === "present") {
      // allowed: owner-only bytes may travel inside a portable bundle
    }
    if (ev.byteLength !== content.byteLength) {
      throw new ContractViolation(`$.evidence[${i}].byteLength`, "content byteLength mismatch");
    }
    if (ev.inclusion !== "present") {
      if (content.inclusion === "present" || content.payloadBase64 !== null) {
        throw new ContractViolation(
          `$.evidence[${i}].inclusion`,
          "dishonest withholding metadata: withheld evidence must not reference present payload bytes",
        );
      }
    }
  }
}

function portableTimelineTargetExists(
  bundle: PortableInvestigationV1,
  namespaceIds: Record<PortableObjectKind, Set<string>>,
  namespace: PortableObjectKind,
  targetId: string,
): boolean {
  if (namespaceIds[namespace].has(targetId)) return true;
  if (namespace === "experiment") {
    const parsed = parsePortableExperimentTraceTarget(targetId);
    return Boolean(parsed && namespaceIds.experiment.has(parsed.experimentId));
  }
  if (namespace !== "triage_job") return false;
  const attempt = parsePortableTriageAttemptTarget(targetId);
  if (!attempt) return false;
  const job = bundle.triageJobs.find((row) => row.id === attempt.jobId);
  return Boolean(job?.candidates.some((row) => row.candidateId === attempt.candidateId));
}

function portableNamespaceIds(
  bundle: PortableInvestigationV1,
): Record<PortableObjectKind, Set<string>> {
  return {
    investigation: new Set([bundle.investigation.id]),
    actor: new Set(bundle.actors.map((row) => row.sourceActorId)),
    contribution: new Set(bundle.contributions.map((row) => row.id)),
    evidence: new Set(bundle.evidence.map((row) => row.id)),
    intake_batch: new Set((bundle.intakeBatches ?? []).map((row) => row.id)),
    content: new Set(bundle.contentObjects.map((row) => row.digest)),
    source: new Set(bundle.sources.map((row) => row.id)),
    imported_ai_run: new Set(bundle.importedAiRuns.map((row) => row.id)),
    snapshot: new Set(bundle.snapshots.map((row) => row.id)),
    triage_job: new Set(bundle.triageJobs.map((row) => row.id)),
    experiment: new Set(bundle.experiments.map((row) => row.id)),
    helpfulness: new Set(bundle.helpfulnessObservations.map((row) => row.id)),
    decision: new Set(bundle.decisions.map((row) => row.id)),
    gold: new Set(bundle.gold.map((row) => row.goldId)),
    alignment: new Set(bundle.alignments.map((row) => row.id)),
    discussion: new Set(bundle.discussions.map((row) => row.id)),
    timeline: new Set(bundle.timeline.map((row) => String(row.seq))),
    audit: new Set(bundle.auditRefs.map((row) => row.id)),
    attachment: new Set(bundle.attachments.map((row) => row.id)),
  };
}

function isPortableObjectKind(value: string): value is PortableObjectKind {
  return (PORTABLE_OBJECT_KINDS as readonly string[]).includes(value);
}

function validateGoldLineage(rows: PortableGoldV1[]): void {
  const byGoldId = new Map(rows.map((row) => [row.goldId, row]));

  for (const [i, row] of rows.entries()) {
    const path = `$.gold[${i}].predecessorGoldId`;
    if (row.version < 1) {
      throw new ContractViolation(`$.gold[${i}].version`, "version must be >= 1");
    }
    if (row.version === 1 && row.predecessorGoldId !== null) {
      throw new ContractViolation(path, "corrupt version chain: version 1 must have no predecessor");
    }
    if (row.version > 1 && row.predecessorGoldId === null) {
      throw new ContractViolation(path, "corrupt version chain: version > 1 requires a predecessor");
    }
    if (row.predecessorGoldId !== null) {
      requireSafeIdentifier(path, row.predecessorGoldId);
      if (row.predecessorGoldId === row.goldId) {
        throw new ContractViolation(path, "gold predecessor self-reference");
      }
      if (!byGoldId.has(row.predecessorGoldId)) {
        throw new ContractViolation(path, "dangling gold predecessor");
      }
    }
  }

  uniqueIds(
    "$.gold.goldId",
    rows.map((row) => row.goldId),
  );

  for (const [i, row] of rows.entries()) {
    const seen = new Set<string>();
    let cursor: PortableGoldV1 | undefined = row;
    while (cursor) {
      if (seen.has(cursor.goldId)) {
        throw new ContractViolation(
          `$.gold[${i}].predecessorGoldId`,
          "cyclic gold predecessor lineage",
        );
      }
      seen.add(cursor.goldId);
      cursor = cursor.predecessorGoldId === null
        ? undefined
        : byGoldId.get(cursor.predecessorGoldId);
    }
  }

  const successorByPredecessor = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    if (row.predecessorGoldId === null) continue;
    const priorSuccessor = successorByPredecessor.get(row.predecessorGoldId);
    if (priorSuccessor && priorSuccessor !== row.goldId) {
      throw new ContractViolation(`$.gold[${i}].predecessorGoldId`, "gold predecessor fork");
    }
    successorByPredecessor.set(row.predecessorGoldId, row.goldId);
  }

  const versionsByExperiment = new Map<string, Set<number>>();
  for (const [i, row] of rows.entries()) {
    const versions = versionsByExperiment.get(row.experimentId) ?? new Set<number>();
    if (versions.has(row.version)) {
      throw new ContractViolation(
        `$.gold[${i}].version`,
        "corrupt version chain: duplicate version in experiment",
      );
    }
    versions.add(row.version);
    versionsByExperiment.set(row.experimentId, versions);

    if (row.predecessorGoldId === null) continue;
    const predecessor = byGoldId.get(row.predecessorGoldId);
    if (!predecessor) continue;
    if (predecessor.experimentId !== row.experimentId) {
      throw new ContractViolation(
        `$.gold[${i}].predecessorGoldId`,
        "gold predecessor must belong to the same experiment",
      );
    }
    if (predecessor.version !== row.version - 1) {
      throw new ContractViolation(
        `$.gold[${i}].predecessorGoldId`,
        "corrupt version chain: predecessor version must be adjacent",
      );
    }
  }
}

export interface ParsePortableInvestigationOptions {
  /** Default true. V1 self-contained bundles require inline bytes for inclusion=present. */
  requireInlinePresentPayload?: boolean;
}

export function parsePortableInvestigation(
  raw: unknown,
  options: ParsePortableInvestigationOptions = {},
): PortableInvestigationV1 {
  checkObject("$", bundleShape, raw);
  const bundle = raw as PortableInvestigationV1;
  assertSafeIdentifiers(bundle);
  assertNoCredentialLeakage(bundle);
  if (!INSTALLATION_ID.test(bundle.sourceInstallationId)) {
    throw new ContractViolation(
      "$.sourceInstallationId",
      "expected opaque inst-* id, not a hostname or endpoint",
    );
  }
  assertShareSafeTimestamp("$.exportedAt", bundle.exportedAt);
  assertShareSafeFingerprint("$.bundleFingerprint", bundle.bundleFingerprint);
  requireSafeIdentifier("$.investigation.id", bundle.investigation.id);
  requireNonEmpty("$.investigation.title", bundle.investigation.title);
  requireNonEmpty("$.investigation.retentionClass", bundle.investigation.retentionClass);
  for (const field of ["problemStatement", "affectedParties", "impact", "scope"] as const) {
    const value = bundle.investigation[field];
    if (value.length > SITUATION_TEXT_LIMIT) {
      throw new ContractViolation(`$.investigation.${field}`, "situation field is too long");
    }
    if (value !== value.trim()) {
      throw new ContractViolation(
        `$.investigation.${field}`,
        "situation field must use its canonical trimmed form",
      );
    }
  }
  if (bundle.investigation.openQuestions.length > SITUATION_QUESTION_COUNT_LIMIT) {
    throw new ContractViolation("$.investigation.openQuestions", "too many open questions");
  }
  for (const [i, question] of bundle.investigation.openQuestions.entries()) {
    requireNonEmpty(`$.investigation.openQuestions[${i}]`, question);
    if (question.length > SITUATION_QUESTION_LIMIT) {
      throw new ContractViolation(
        `$.investigation.openQuestions[${i}]`,
        "open question is too long",
      );
    }
    if (question !== question.trim()) {
      throw new ContractViolation(
        `$.investigation.openQuestions[${i}]`,
        "open question must use its canonical trimmed form",
      );
    }
  }
  assertShareSafeTimestamp("$.investigation.createdAt", bundle.investigation.createdAt);

  uniqueIds(
    "$.actors.sourceActorId",
    bundle.actors.map((row) => row.sourceActorId),
  );
  const actors = new Map(bundle.actors.map((row) => [row.sourceActorId, row]));
  requireActor(actors, bundle.investigation.createdBy, "$.investigation.createdBy");

  uniqueIds(
    "$.participants.sourceActorId",
    bundle.participants.map((row) => row.sourceActorId),
  );
  for (const [i, participant] of bundle.participants.entries()) {
    requireActor(actors, participant.sourceActorId, `$.participants[${i}].sourceActorId`);
    requireNonEmpty(`$.participants[${i}].role`, participant.role);
  }

  uniqueIds(
    "$.sources.id",
    bundle.sources.map((row) => row.id),
  );
  const sources = byId(bundle.sources);
  for (const [i, source] of bundle.sources.entries()) {
    requireActor(actors, source.createdBy, `$.sources[${i}].createdBy`);
    if (source.identityId !== null) {
      requireActor(actors, source.identityId, `$.sources[${i}].identityId`);
    }
  }

  uniqueIds(
    "$.contributions",
    bundle.contributions.map((row) => `${row.id}:${row.revision}`),
  );
  assertVersionChain("$.contributions", bundle.contributions);
  for (const [i, row] of bundle.contributions.entries()) {
    requireSha256(`$.contributions[${i}].contentHash`, row.contentHash);
    requireActor(actors, row.authorId, `$.contributions[${i}].authorId`);
    if (!sources.has(row.sourceId)) {
      throw new ContractViolation(`$.contributions[${i}].sourceId`, "dangling source reference");
    }
    assertShareSafeTimestamp(`$.contributions[${i}].createdAt`, row.createdAt);
    if (row.privacyClass === "owner_only" && row.body !== null && row.tombstoned) {
      throw new ContractViolation(
        `$.contributions[${i}].body`,
        "illegal privacy claim: tombstoned owner-only body must be omitted",
      );
    }
    if (row.body !== null) {
      const digest = sha256Text(row.body);
      if (digest !== row.contentHash) {
        throw new ContractViolation(`$.contributions[${i}].contentHash`, "hash/fingerprint mismatch");
      }
    }
  }

  uniqueIds(
    "$.evidence.id",
    bundle.evidence.map((row) => row.id),
  );
  const evidence = byId(bundle.evidence);
  for (const [i, row] of bundle.evidence.entries()) {
    requireActor(actors, row.createdBy, `$.evidence[${i}].createdBy`);
    assertShareSafeTimestamp(`$.evidence[${i}].createdAt`, row.createdAt);
    if (row.sourceId !== undefined && !sources.has(row.sourceId)) {
      throw new ContractViolation(`$.evidence[${i}].sourceId`, "dangling source reference");
    }
    if (
      row.summaryContributionId !== undefined &&
      row.summaryContributionId !== null &&
      !bundle.contributions.some((item) => item.id === row.summaryContributionId)
    ) {
      throw new ContractViolation(
        `$.evidence[${i}].summaryContributionId`,
        "dangling contribution reference",
      );
    }
  }
  const portableContributionIds = new Set(bundle.contributions.map((row) => row.id));
  for (const [i, row] of bundle.contributions.entries()) {
    const links = row.hypothesisLinks ?? [];
    for (const [j, link] of links.entries()) {
      if (link.kind === "artifact" && !evidence.has(link.id)) {
        throw new ContractViolation(
          `$.contributions[${i}].hypothesisLinks[${j}].id`,
          "dangling evidence reference",
        );
      }
      if (link.kind === "contribution" && !portableContributionIds.has(link.id)) {
        throw new ContractViolation(
          `$.contributions[${i}].hypothesisLinks[${j}].id`,
          "dangling contribution reference",
        );
      }
    }
  }
  validateContent(bundle, options);

  const intakeBatches = bundle.intakeBatches ?? [];
  uniqueIds("$.intakeBatches.id", intakeBatches.map((row) => row.id));
  const intakeById = new Map(intakeBatches.map((row) => [row.id, row]));
  const evidenceById = new Map(bundle.evidence.map((row) => [row.id, row]));
  for (const [i, batch] of intakeBatches.entries()) {
    requireActor(actors, batch.createdBy, `$.intakeBatches[${i}].createdBy`);
    assertShareSafeTimestamp(`$.intakeBatches[${i}].createdAt`, batch.createdAt);
    requireSha256(`$.intakeBatches[${i}].requestDigest`, batch.requestDigest);
    if (batch.caseId !== bundle.investigation.id) {
      throw new ContractViolation(`$.intakeBatches[${i}].caseId`, "wrong investigation reference");
    }
    let parsed;
    try {
      parsed = parseCorpusIntakeBatch(JSON.parse(batch.payloadJson));
    } catch {
      throw new ContractViolation(`$.intakeBatches[${i}].payloadJson`, "invalid corpus intake batch");
    }
    if (
      parsed.id !== batch.id ||
      parsed.caseId !== batch.caseId ||
      parsed.idempotencyKey !== batch.idempotencyKey ||
      parsed.requestDigest !== batch.requestDigest ||
      parsed.origin !== batch.origin ||
      parsed.sourceLabel !== batch.sourceLabel ||
      parsed.privacyClass !== batch.privacyClass ||
      parsed.createdAt !== batch.createdAt ||
      parsed.createdBy !== batch.createdBy
    ) {
      throw new ContractViolation(
        `$.intakeBatches[${i}].payloadJson`,
        "corpus intake batch envelope does not match its payload",
      );
    }
    for (const [j, item] of parsed.items.entries()) {
      const evidence = evidenceById.get(item.artifactId);
      if (!evidence || evidence.intakeBatchId !== batch.id) {
        throw new ContractViolation(
          `$.intakeBatches[${i}].payloadJson.items[${j}].artifactId`,
          "dangling intake evidence reference",
        );
      }
      if (
        evidence.relativePath !== item.relativePath ||
        evidence.digest !== item.digest ||
        evidence.byteLength !== item.byteLength ||
        evidence.contentType !== item.mediaType ||
        evidence.privacyClass !== item.privacyClass ||
        evidence.sourceId !== item.sourceId
      ) {
        throw new ContractViolation(
          `$.intakeBatches[${i}].payloadJson.items[${j}]`,
          "intake item does not match exported evidence",
        );
      }
    }
  }
  for (const [i, row] of bundle.evidence.entries()) {
    if (row.intakeBatchId === undefined || row.intakeBatchId === null) continue;
    if (!intakeById.has(row.intakeBatchId)) {
      throw new ContractViolation(`$.evidence[${i}].intakeBatchId`, "dangling intake batch reference");
    }
    if (
      row.artifactKind === undefined ||
      row.sourceId === undefined ||
      row.relativePath === undefined ||
      row.relativePath === null
    ) {
      throw new ContractViolation(
        `$.evidence[${i}]`,
        "intake evidence requires kind, source, and relative path",
      );
    }
  }

  uniqueIds(
    "$.importedAiRuns.id",
    bundle.importedAiRuns.map((row) => row.id),
  );
  for (const [i, row] of bundle.importedAiRuns.entries()) {
    if (!sources.has(row.sourceId)) {
      throw new ContractViolation(`$.importedAiRuns[${i}].sourceId`, "dangling source reference");
    }
    assertShareSafeTimestamp(`$.importedAiRuns[${i}].importedAt`, row.importedAt);
    const opaque = parseOpaquePayloadJson(
      `$.importedAiRuns[${i}].opaquePayloadJson`,
      row.opaquePayloadJson,
    );
    if (row.opaquePayloadJson !== null && opaque !== row.opaquePayloadJson) {
      throw new ContractViolation(
        `$.importedAiRuns[${i}].opaquePayloadJson`,
        "opaquePayloadJson must be canonical JSON",
      );
    }
    if (row.outputDigest !== null) {
      requireContentDigest(
        bundle.contentObjects,
        row.outputDigest,
        `$.importedAiRuns[${i}].outputDigest`,
        row.outputCompleteness === "exact",
      );
    }
    if (row.outputCompleteness === "exact" && !row.outputDigest) {
      throw new ContractViolation(
        `$.importedAiRuns[${i}].outputDigest`,
        "exact output completeness requires an output digest",
      );
    }
    if (row.promptDigest) {
      requireContentDigest(
        bundle.contentObjects,
        row.promptDigest,
        `$.importedAiRuns[${i}].promptDigest`,
        row.promptCompleteness === "exact",
      );
    }
    if (row.promptCompleteness === "exact" && !row.promptDigest) {
      throw new ContractViolation(
        `$.importedAiRuns[${i}].promptDigest`,
        "exact prompt completeness requires a prompt digest",
      );
    }
    if (row.operatorId) {
      requireActor(actors, row.operatorId, `$.importedAiRuns[${i}].operatorId`);
    }
    if (row.importerId) {
      requireActor(actors, row.importerId, `$.importedAiRuns[${i}].importerId`);
    }
    if (row.contributionId) {
      const bound = bundle.contributions.find((item) => item.id === row.contributionId);
      if (!bound) {
        throw new ContractViolation(
          `$.importedAiRuns[${i}].contributionId`,
          "dangling contribution reference",
        );
      }
      if (bound.kind !== "external_run") {
        throw new ContractViolation(
          `$.importedAiRuns[${i}].contributionId`,
          "imported run must bind an external-run contribution",
        );
      }
    }
  }
  uniqueIds(
    "$.importedAiRuns.contributionId",
    bundle.importedAiRuns.flatMap((row) => row.contributionId ? [row.contributionId] : []),
  );

  uniqueIds(
    "$.snapshots.id",
    bundle.snapshots.map((row) => row.id),
  );
  const snapshots = byId(bundle.snapshots);
  for (const [i, row] of bundle.importedAiRuns.entries()) {
    if (row.snapshotId && !snapshots.has(row.snapshotId)) {
      throw new ContractViolation(`$.importedAiRuns[${i}].snapshotId`, "dangling snapshot reference");
    }
  }
  for (const [i, snap] of bundle.snapshots.entries()) {
    requireActor(actors, snap.createdBy, `$.snapshots[${i}].createdBy`);
    assertShareSafeTimestamp(`$.snapshots[${i}].createdAt`, snap.createdAt);
    assertShareSafeFingerprint(`$.snapshots[${i}].fingerprint`, snap.fingerprint);
    const seenEvidence = new Set<string>();
    const seenOrdinal = new Set<number>();
    let hashed = 0;
    for (const [j, item] of snap.evidence.entries()) {
      if (!evidence.has(item.evidenceId)) {
        throw new ContractViolation(
          `$.snapshots[${i}].evidence[${j}].evidenceId`,
          "dangling evidence reference",
        );
      }
      if (seenEvidence.has(item.evidenceId)) {
        throw new ContractViolation(
          `$.snapshots[${i}].evidence[${j}].evidenceId`,
          "duplicate id",
        );
      }
      seenEvidence.add(item.evidenceId);
      if (seenOrdinal.has(item.ordinal)) {
        throw new ContractViolation(`$.snapshots[${i}].evidence[${j}].ordinal`, "duplicate ordinal");
      }
      seenOrdinal.add(item.ordinal);
      const exported = evidence.get(item.evidenceId);
      if (!exported) {
        throw new ContractViolation(
          `$.snapshots[${i}].evidence[${j}].evidenceId`,
          "dangling evidence reference",
        );
      }
      if (item.privacyClass !== exported.privacyClass) {
        throw new ContractViolation(
          `$.snapshots[${i}].evidence[${j}].privacyClass`,
          "snapshot privacyClass does not match exported evidence",
        );
      }
      if (item.contentHash !== null) {
        requireSha256(`$.snapshots[${i}].evidence[${j}].contentHash`, item.contentHash);
        if (item.contentHash !== exported.digest) {
          throw new ContractViolation(
            `$.snapshots[${i}].evidence[${j}].contentHash`,
            "snapshot contentHash does not match exported evidence",
          );
        }
        hashed += 1;
      }
      if (snap.visibility === "share_safe" && item.privacyClass !== "share_safe") {
        throw new ContractViolation(
          `$.snapshots[${i}].evidence[${j}].privacyClass`,
          "illegal privacy claim: share-safe snapshot cannot include owner-only evidence",
        );
      }
    }
    const expectedFairness = snap.evidence.length === 0 || hashed === snap.evidence.length
      ? "same_snapshot"
      : "unknown";
    if (snap.fairnessClass !== expectedFairness) {
      throw new ContractViolation(`$.snapshots[${i}].fairnessClass`, "hash/fingerprint mismatch");
    }
    if (snap.parentSnapshotId === snap.id) {
      throw new ContractViolation(`$.snapshots[${i}].parentSnapshotId`, "self/cyclic lineage");
    }
    const expectedFp = portableSnapshotFingerprint(snap);
    if (snap.fingerprint !== expectedFp) {
      throw new ContractViolation(`$.snapshots[${i}].fingerprint`, "hash/fingerprint mismatch");
    }
  }
  detectSnapshotCycles(bundle.snapshots);

  uniqueIds(
    "$.triageJobs.id",
    bundle.triageJobs.map((row) => row.id),
  );
  const jobs = byId(bundle.triageJobs);
  for (const [i, job] of bundle.triageJobs.entries()) {
    requireActor(actors, job.requestedBy, `$.triageJobs[${i}].requestedBy`);
    const snap = snapshots.get(job.snapshotId);
    if (!snap) {
      throw new ContractViolation(`$.triageJobs[${i}].snapshotId`, "dangling snapshot reference");
    }
    if (job.snapshotFingerprint !== snap.fingerprint) {
      throw new ContractViolation(`$.triageJobs[${i}].snapshotFingerprint`, "hash/fingerprint mismatch");
    }
    if (job.parentJobId !== null && job.parentJobId === job.id) {
      throw new ContractViolation(`$.triageJobs[${i}].parentJobId`, "self/cyclic lineage");
    }
    if (job.parentJobId !== null && !jobs.has(job.parentJobId)) {
      throw new ContractViolation(`$.triageJobs[${i}].parentJobId`, "dangling triage job reference");
    }
    assertShareSafeFingerprint(`$.triageJobs[${i}].requestFingerprint`, job.requestFingerprint);
    uniqueIds(
      `$.triageJobs[${i}].candidates.candidateId`,
      job.candidates.map((row) => row.candidateId),
    );
    for (const [j, cand] of job.candidates.entries()) {
      for (const [k, ref] of cand.evidenceRefs.entries()) {
        if (!evidence.has(ref)) {
          throw new ContractViolation(
            `$.triageJobs[${i}].candidates[${j}].evidenceRefs[${k}]`,
            "dangling evidence reference",
          );
        }
      }
    }
  }
  const backedCandidateIds = new Set([
    ...bundle.triageJobs.flatMap((job) => job.candidates.map((row) => row.candidateId)),
    ...bundle.importedAiRuns.map((run) => `chat-${run.id}`),
  ]);

  uniqueIds(
    "$.experiments.id",
    bundle.experiments.map((row) => row.id),
  );
  const experiments = byId(bundle.experiments);
  for (const [i, exp] of bundle.experiments.entries()) {
    assertShareSafeFingerprint(`$.experiments[${i}].snapshotFingerprint`, exp.snapshotFingerprint);
    assertShareSafeFingerprint(`$.experiments[${i}].taskFingerprint`, exp.taskFingerprint);
    if (!bundle.snapshots.some((snap) => snap.fingerprint === exp.snapshotFingerprint)) {
      throw new ContractViolation(`$.experiments[${i}].snapshotFingerprint`, "dangling snapshot fingerprint");
    }
    uniqueIds(
      `$.experiments[${i}].candidateIds`,
      exp.candidateIds,
    );
    for (const [j, candidateId] of exp.candidateIds.entries()) {
      if (!backedCandidateIds.has(candidateId)) {
        throw new ContractViolation(
          `$.experiments[${i}].candidateIds[${j}]`,
          "experiment candidate is not backed by a triage job or imported AI run",
        );
      }
    }
    if (exp.importerId) {
      requireActor(actors, exp.importerId, `$.experiments[${i}].importerId`);
    }
  }

  uniqueIds(
    "$.helpfulnessObservations.id",
    bundle.helpfulnessObservations.map((row) => row.id),
  );
  for (const [i, row] of bundle.helpfulnessObservations.entries()) {
    const experiment = experiments.get(row.experimentId);
    if (!experiment) {
      throw new ContractViolation(
        `$.helpfulnessObservations[${i}].experimentId`,
        "dangling experiment reference",
      );
    }
    if (!experiment.candidateIds.includes(row.candidateId)) {
      throw new ContractViolation(
        `$.helpfulnessObservations[${i}].candidateId`,
        "candidate does not belong to that experiment",
      );
    }
    requireActor(actors, row.reviewerId, `$.helpfulnessObservations[${i}].reviewerId`);
    for (const [j, ref] of row.evidenceRefs.entries()) {
      if (!evidence.has(ref)) {
        throw new ContractViolation(
          `$.helpfulnessObservations[${i}].evidenceRefs[${j}]`,
          "dangling evidence reference",
        );
      }
    }
  }

  uniqueIds(
    "$.decisions",
    bundle.decisions.map((row) => `${row.id}:${row.revision}`),
  );
  assertVersionChain("$.decisions", bundle.decisions);
  const decisions = new Map(
    bundle.decisions.map((row) => [`${row.id}:${row.revision}`, row]),
  );
  for (const [i, row] of bundle.decisions.entries()) {
    if (!experiments.has(row.experimentId)) {
      throw new ContractViolation(`$.decisions[${i}].experimentId`, "dangling experiment reference");
    }
    requireActor(actors, row.authorId, `$.decisions[${i}].authorId`);
    if (row.ownerId !== undefined && row.ownerId !== null) {
      requireActor(actors, row.ownerId, `$.decisions[${i}].ownerId`);
    }
    const seenUnknowns = new Set<string>();
    for (const [j, unknown] of (row.remainingUnknowns ?? []).entries()) {
      const normalized = unknown.trim();
      if (!normalized) {
        throw new ContractViolation(
          `$.decisions[${i}].remainingUnknowns[${j}]`,
          "remaining unknown must not be empty",
        );
      }
      if (seenUnknowns.has(normalized)) {
        throw new ContractViolation(
          `$.decisions[${i}].remainingUnknowns[${j}]`,
          "remaining unknown must be unique",
        );
      }
      seenUnknowns.add(normalized);
    }
    for (const [j, ref] of row.evidenceRefs.entries()) {
      if (!evidence.has(ref)) {
        throw new ContractViolation(
          `$.decisions[${i}].evidenceRefs[${j}]`,
          "dangling evidence reference",
        );
      }
    }
  }

  validateGoldLineage(bundle.gold);
  for (const [i, row] of bundle.gold.entries()) {
    if (!experiments.has(row.experimentId)) {
      throw new ContractViolation(`$.gold[${i}].experimentId`, "dangling experiment reference");
    }
    const accepted = decisions.get(`${row.acceptedDecisionId}:${row.acceptedDecisionRevision}`);
    if (!accepted || accepted.status !== "accepted") {
      throw new ContractViolation(
        `$.gold[${i}].acceptedDecisionId`,
        "dangling or non-accepted decision",
      );
    }
    if (accepted.experimentId !== row.experimentId) {
      throw new ContractViolation(
        `$.gold[${i}].acceptedDecisionId`,
        "gold accepted decision must belong to the same experiment",
      );
    }
    if (!row.notes.includes(GOLD_IS_HUMAN_BENCHMARK)) {
      throw new ContractViolation(`$.gold[${i}].notes`, "gold must declare the human-benchmark caveat");
    }
    requireActor(actors, row.promotedById, `$.gold[${i}].promotedById`);
    for (const [j, ref] of row.evidenceAnchors.entries()) {
      if (!evidence.has(ref)) {
        throw new ContractViolation(`$.gold[${i}].evidenceAnchors[${j}]`, "dangling evidence reference");
      }
    }
  }

  uniqueIds(
    "$.alignments.id",
    bundle.alignments.map((row) => row.id),
  );
  for (const [i, row] of bundle.alignments.entries()) {
    const gold = bundle.gold.find((item) => item.goldId === row.goldId);
    if (!gold) {
      throw new ContractViolation(`$.alignments[${i}].goldId`, "dangling gold reference");
    }
    const goldExperiment = experiments.get(gold.experimentId);
    if (!goldExperiment || !goldExperiment.candidateIds.includes(row.candidateId)) {
      throw new ContractViolation(
        `$.alignments[${i}].candidateId`,
        "candidate does not belong to that experiment",
      );
    }
    if (!row.notes.includes(GOLD_ALIGNMENT_NOT_CORRECTNESS)) {
      throw new ContractViolation(
        `$.alignments[${i}].notes`,
        "alignment must declare that gold alignment is not a correctness verdict",
      );
    }
  }

  uniqueIds(
    "$.discussions.id",
    bundle.discussions.map((row) => row.id),
  );
  const discussions = byId(bundle.discussions);
  const contributionIds = new Set(bundle.contributions.map((row) => row.id));
  for (const [i, row] of bundle.discussions.entries()) {
    requireActor(actors, row.authorId, `$.discussions[${i}].authorId`);
    for (const [j, messageId] of row.messageIds.entries()) {
      if (!contributionIds.has(messageId)) {
        throw new ContractViolation(
          `$.discussions[${i}].messageIds[${j}]`,
          "dangling contribution reference",
        );
      }
    }
  }

  uniqueIds(
    "$.timeline.seq",
    bundle.timeline.map((row) => String(row.seq)),
  );
  const namespaceIds = portableNamespaceIds(bundle);
  for (const [i, row] of bundle.timeline.entries()) {
    requireActor(actors, row.actorId, `$.timeline[${i}].actorId`);
    assertShareSafeTimestamp(`$.timeline[${i}].serverTime`, row.serverTime);
    if ((row.targetId === null) !== (row.targetNamespace === null)) {
      throw new ContractViolation(
        `$.timeline[${i}]`,
        "timeline targetId and targetNamespace must both be null or both be set",
      );
    }
    if (row.targetId === null || row.targetNamespace === null) continue;
    requireSafeIdentifier(`$.timeline[${i}].targetNamespace`, row.targetNamespace);
    if (!isPortableObjectKind(row.targetNamespace)) {
      throw new ContractViolation(
        `$.timeline[${i}].targetNamespace`,
        "unknown timeline target namespace",
      );
    }
    if (!portableTimelineTargetExists(bundle, namespaceIds, row.targetNamespace, row.targetId)) {
      throw new ContractViolation(`$.timeline[${i}].targetId`, "dangling timeline target");
    }
  }

  uniqueIds(
    "$.auditRefs.id",
    bundle.auditRefs.map((row) => row.id),
  );
  for (const [i, row] of bundle.auditRefs.entries()) {
    requireActor(actors, row.actorId, `$.auditRefs[${i}].actorId`);
    requireSha256(`$.auditRefs[${i}].summaryHash`, row.summaryHash);
  }

  uniqueIds(
    "$.attachments.id",
    bundle.attachments.map((row) => row.id),
  );
  const contents = new Map(bundle.contentObjects.map((row) => [row.digest, row]));
  for (const [i, row] of bundle.attachments.entries()) {
    if (!evidence.has(row.evidenceId)) {
      throw new ContractViolation(`$.attachments[${i}].evidenceId`, "dangling evidence reference");
    }
    if (row.discussionId !== null && !discussions.has(row.discussionId)) {
      throw new ContractViolation(`$.attachments[${i}].discussionId`, "dangling discussion reference");
    }
    const content = contents.get(row.digest);
    if (!content) {
      throw new ContractViolation(`$.attachments[${i}].digest`, "dangling content digest");
    }
    if (row.inclusion !== "present") {
      if (content.inclusion === "present" || content.payloadBase64 !== null) {
        throw new ContractViolation(
          `$.attachments[${i}].inclusion`,
          "dishonest withholding metadata: withheld attachment must not reference present payload bytes",
        );
      }
    }
  }

  const expectedHashes = computePortableObjectHashes(bundle);
  const actualHashes = sortBy(bundle.objectHashes, (row) => `${row.kind}:${row.id}`);
  if (canonicalJson(actualHashes) !== canonicalJson(expectedHashes)) {
    throw new ContractViolation("$.objectHashes", "hash/fingerprint mismatch");
  }
  const expectedMap = hashMap(expectedHashes);
  const checkField = (path: string, kind: PortableObjectKind, id: string, objectHash: string) => {
    if (objectHash !== expectedMap.get(`${kind}:${id}`)) {
      throw new ContractViolation(path, "hash/fingerprint mismatch");
    }
  };
  checkField("$.investigation.objectHash", "investigation", bundle.investigation.id, bundle.investigation.objectHash);
  for (const row of bundle.actors) {
    checkField("$.actors.objectHash", "actor", row.sourceActorId, row.objectHash);
  }
  for (const row of bundle.contributions) {
    checkField("$.contributions.objectHash", "contribution", `${row.id}:${row.revision}`, row.objectHash);
  }
  for (const row of bundle.evidence) {
    checkField("$.evidence.objectHash", "evidence", row.id, row.objectHash);
  }
  for (const row of bundle.contentObjects) {
    checkField("$.contentObjects.objectHash", "content", row.digest, row.objectHash);
  }
  for (const row of bundle.sources) {
    checkField("$.sources.objectHash", "source", row.id, row.objectHash);
  }
  for (const row of bundle.importedAiRuns) {
    checkField("$.importedAiRuns.objectHash", "imported_ai_run", row.id, row.objectHash);
  }
  for (const row of bundle.snapshots) {
    checkField("$.snapshots.objectHash", "snapshot", row.id, row.objectHash);
  }
  for (const row of bundle.triageJobs) {
    checkField("$.triageJobs.objectHash", "triage_job", row.id, row.objectHash);
  }
  for (const row of bundle.experiments) {
    checkField("$.experiments.objectHash", "experiment", row.id, row.objectHash);
  }
  for (const row of bundle.helpfulnessObservations) {
    checkField("$.helpfulnessObservations.objectHash", "helpfulness", row.id, row.objectHash);
  }
  for (const row of bundle.decisions) {
    checkField("$.decisions.objectHash", "decision", `${row.id}:${row.revision}`, row.objectHash);
  }
  for (const row of bundle.gold) {
    checkField("$.gold.objectHash", "gold", `${row.goldId}:${row.version}`, row.objectHash);
  }
  for (const row of bundle.alignments) {
    checkField("$.alignments.objectHash", "alignment", row.id, row.objectHash);
  }
  for (const row of bundle.discussions) {
    checkField("$.discussions.objectHash", "discussion", row.id, row.objectHash);
  }
  for (const row of bundle.timeline) {
    checkField("$.timeline.objectHash", "timeline", String(row.seq), row.objectHash);
  }
  for (const row of bundle.auditRefs) {
    checkField("$.auditRefs.objectHash", "audit", row.id, row.objectHash);
  }
  for (const row of bundle.attachments) {
    checkField("$.attachments.objectHash", "attachment", row.id, row.objectHash);
  }
  const expectedFp = portableBundleFingerprint(bundle);
  if (bundle.bundleFingerprint !== expectedFp) {
    throw new ContractViolation("$.bundleFingerprint", "hash/fingerprint mismatch");
  }
  return bundle;
}

export interface IdentityMapEntryV1 {
  sourceActorId: string;
  action: IdentityAction;
  destinationActorId: string | null;
}

export interface DestinationIdentityV1 {
  actorId: string;
  username: string;
  email: string | null;
  displayName: string;
}

export interface DestinationCatalogV1 {
  identities: DestinationIdentityV1[];
  objectIds: Partial<Record<PortableObjectKind, string[]>>;
  knownProfileIds: string[];
}

export interface PreflightRequestV1 {
  mode: "dry_run";
  collisionPolicy: CollisionPolicy;
  identityMap: IdentityMapEntryV1[];
  destination: DestinationCatalogV1;
}

export interface PreflightWarningV1 {
  code: string;
  path: string;
  detail: string;
}

export interface PreflightIdRemapV1 {
  namespace: PortableObjectKind;
  sourceId: string;
  destinationId: string;
}

export interface PreflightReportV1 {
  schemaId: typeof PORTABLE_PREFLIGHT_SCHEMA_ID;
  mode: "dry_run";
  bundleFingerprint: string;
  semanticFingerprint: string;
  sourceInstallationId: string;
  counts: { create: number; update: number; conflict: number; blocked: number };
  collisionPolicy: CollisionPolicy;
  warnings: PreflightWarningV1[];
  referentialIntegrityFailures: PreflightWarningV1[];
  idRemap: PreflightIdRemapV1[];
  identityResolutions: IdentityMapEntryV1[];
  reconstructionStatus: ReconstructionStatus;
  reconstructionReasons: ReconstructionReasonV1[];
  exactReconstruction: boolean;
  applyAuthorized: false;
  destinationCatalogDigest: string;
  destinationCatalogIsAuthorization: false;
  destinationCatalogMustRevalidate: true;
  historicalParticipantsAreAttributionOnly: true;
  destinationMembershipGranted: false;
  destinationRoleGranted: false;
  destinationCapabilityGranted: false;
}

const identityMapEntryShape: ObjectShape = {
  sourceActorId: f.req(f.str),
  action: f.req(f.en(...IDENTITY_ACTIONS)),
  destinationActorId: f.nul(f.str),
};

const destinationIdentityShape: ObjectShape = {
  actorId: f.req(f.str),
  username: f.req(f.str),
  email: f.nul(f.str),
  displayName: f.req(f.str),
};

const preflightRequestShape: ObjectShape = {
  mode: f.req(f.en("dry_run")),
  collisionPolicy: f.req(f.en(...COLLISION_POLICIES)),
  identityMap: f.req(f.arr(f.obj(identityMapEntryShape))),
  destination: f.req(
    f.obj({
      identities: f.req(f.arr(f.obj(destinationIdentityShape))),
      objectIds: f.req(
        f.obj(
          Object.fromEntries(
            PORTABLE_OBJECT_KINDS.map((kind) => [kind, f.opt(f.arr(f.str))]),
          ) as ObjectShape,
        ),
      ),
      knownProfileIds: f.req(f.arr(f.str)),
    }),
  ),
};

const MAX_DETERMINISTIC_REMAP_ATTEMPTS = 256;

function chooseDeterministicRemap(
  installationId: string,
  namespace: PortableObjectKind,
  sourceId: string,
  occupied: Set<string>,
): string {
  for (let attempt = 0; attempt < MAX_DETERMINISTIC_REMAP_ATTEMPTS; attempt += 1) {
    const candidate = portableDestinationUuid(installationId, namespace, sourceId, attempt);
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new ContractViolation(
    `$.destination.objectIds.${namespace}`,
    `deterministic remap space exhausted for ${sourceId}`,
  );
}


export function projectSemanticInvestigation(
  bundle: PortableInvestigationV1 | PortableInvestigationUnsigned,
): unknown {
  const sorted = sortPortableBags(bundle);
  const stripRow = <T extends { objectHash?: string }>(row: T): Omit<T, "objectHash"> => stripHash(row);
  const content = sorted.contentObjects.map((row) => {
    const { payloadBase64: _payload, objectHash: _hash, ...rest } = row;
    return rest;
  });
  return {
    schemaId: PORTABLE_SCHEMA_ID,
    protocolVersion: PORTABLE_PROTOCOL_VERSION,
    sourceInstallationId: sorted.sourceInstallationId,
    permissionCaveat: sorted.permissionCaveat,
    historyCaveat: sorted.historyCaveat,
    investigation: stripRow(sorted.investigation),
    actors: sorted.actors.map(stripRow),
    participants: sorted.participants,
    contributions: sorted.contributions.map(stripRow),
    evidence: sorted.evidence.map(stripRow),
    contentObjects: content,
    sources: sorted.sources.map(stripRow),
    importedAiRuns: sorted.importedAiRuns.map(stripRow),
    snapshots: sorted.snapshots.map((row) => stripRow(row)),
    triageJobs: sorted.triageJobs.map((row) => stripRow(row)),
    experiments: sorted.experiments.map(stripRow),
    helpfulnessObservations: sorted.helpfulnessObservations.map(stripRow),
    decisions: sorted.decisions.map(stripRow),
    gold: sorted.gold.map(stripRow),
    alignments: sorted.alignments.map(stripRow),
    discussions: sorted.discussions.map(stripRow),
    timeline: sorted.timeline.map(stripRow),
    auditRefs: sorted.auditRefs.map(stripRow),
    attachments: sorted.attachments.map(stripRow),
  };
}

export function portableSemanticFingerprint(
  bundle: PortableInvestigationV1 | PortableInvestigationUnsigned,
): string {
  return sha256Text(canonicalJson(projectSemanticInvestigation(bundle)));
}

export function destinationCatalogDigest(catalog: DestinationCatalogV1): string {
  const identities = [...catalog.identities]
    .map((row) => ({
      actorId: row.actorId,
      username: row.username,
      email: row.email,
      displayName: row.displayName,
    }))
    .sort((a, b) => compareCodeUnits(a.actorId, b.actorId));
  const objectIds: Record<string, string[]> = {};
  for (const kind of [...PORTABLE_OBJECT_KINDS].sort(compareCodeUnits)) {
    const ids = catalog.objectIds[kind];
    if (!ids) continue;
    objectIds[kind] = [...ids].sort(compareCodeUnits);
  }
  const knownProfileIds = [...catalog.knownProfileIds].sort(compareCodeUnits);
  return sha256Text(canonicalJson({ identities, objectIds, knownProfileIds }));
}

function sortReconstructionReasons(rows: ReconstructionReasonV1[]): ReconstructionReasonV1[] {
  return [...rows].sort((a, b) => {
    const path = compareCodeUnits(a.path, b.path);
    if (path !== 0) return path;
    const code = compareCodeUnits(a.code, b.code);
    if (code !== 0) return code;
    return compareCodeUnits(a.detail, b.detail);
  });
}

export function evaluatePortableReconstruction(input: {
  evidence: ReadonlyArray<{ id: string; inclusion: ContentInclusion }>;
  contentObjects: ReadonlyArray<{
    digest: string;
    inclusion: ContentInclusion;
    payloadBase64?: string | null;
    byteLength?: number;
  }>;
  referentialIntegrityFailures: ReadonlyArray<PreflightWarningV1>;
  extraReasons?: readonly ReconstructionReasonV1[];
}): {
  reconstructionStatus: ReconstructionStatus;
  reconstructionReasons: ReconstructionReasonV1[];
  exactReconstruction: boolean;
} {
  const reasons: ReconstructionReasonV1[] = [...(input.extraReasons ?? [])];
  for (const ev of input.evidence) {
    if (ev.inclusion === "omitted") {
      reasons.push({
        code: "content_omitted",
        path: `evidence:${ev.id}`,
        detail: "content is omitted",
      });
    } else if (ev.inclusion === "private") {
      reasons.push({
        code: "content_private",
        path: `evidence:${ev.id}`,
        detail: "content is private",
      });
    } else if (ev.inclusion === "redacted") {
      reasons.push({
        code: "content_redacted",
        path: `evidence:${ev.id}`,
        detail: "content is redacted",
      });
    }
  }
  for (const row of input.contentObjects) {
    if (row.inclusion === "omitted") {
      reasons.push({
        code: "content_omitted",
        path: `content:${row.digest}`,
        detail: "content is omitted",
      });
    } else if (row.inclusion === "private") {
      reasons.push({
        code: "content_private",
        path: `content:${row.digest}`,
        detail: "content is private",
      });
    } else if (row.inclusion === "redacted") {
      reasons.push({
        code: "content_redacted",
        path: `content:${row.digest}`,
        detail: "content is redacted",
      });
    }
    if (row.inclusion === "present" && "payloadBase64" in row) {
      const payload = row.payloadBase64;
      if (payload === null || payload === undefined) {
        reasons.push({
          code: "declared_present_bytes_missing",
          path: `content:${row.digest}`,
          detail: "declared-present blob bytes are not inline and were not supplied",
        });
      } else {
        const bytes = Buffer.from(payload, "base64");
        if (row.byteLength !== undefined && bytes.byteLength !== row.byteLength) {
          reasons.push({
            code: "declared_present_length_mismatch",
            path: `content:${row.digest}`,
            detail: "declared-present blob length does not match",
          });
        }
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== row.digest) {
          reasons.push({
            code: "declared_present_digest_mismatch",
            path: `content:${row.digest}`,
            detail: "declared-present blob digest does not match",
          });
        }
      }
    }
  }
  for (const row of input.referentialIntegrityFailures) {
    if (row.code === "missing_user") {
      reasons.push({
        code: "missing_user",
        path: row.path,
        detail: row.detail,
      });
    } else if (row.code === "id_collision") {
      reasons.push({
        code: "id_collision",
        path: row.path,
        detail: row.detail,
      });
    } else {
      reasons.push({
        code: "blocking_identity_action",
        path: row.path,
        detail: row.detail,
      });
    }
  }
  const sorted = sortReconstructionReasons(reasons);
  const blocked = sorted.some((row) =>
    row.code === "missing_user" ||
    row.code === "id_collision" ||
    row.code === "blocking_identity_action" ||
    row.code === "declared_present_bytes_missing" ||
    row.code === "declared_present_digest_mismatch" ||
    row.code === "declared_present_length_mismatch"
  );
  const metadata = sorted.some((row) =>
    row.code === "content_omitted" ||
    row.code === "content_private" ||
    row.code === "content_redacted"
  );
  const reconstructionStatus: ReconstructionStatus = blocked
    ? "blocked"
    : metadata
      ? "metadata_only"
      : "exact";
  return {
    reconstructionStatus,
    reconstructionReasons: sorted,
    exactReconstruction: reconstructionStatus === "exact",
  };
}

export function preflightPortableInvestigation(
  bundleRaw: unknown,
  requestRaw: unknown,
  parseOptions: ParsePortableInvestigationOptions = {},
): PreflightReportV1 {
  if (
    typeof requestRaw === "object" &&
    requestRaw !== null &&
    "mode" in requestRaw &&
    (requestRaw as { mode: unknown }).mode !== "dry_run"
  ) {
    throw new ContractViolation("$.mode", "dry-run is required before apply");
  }
  checkObject("$", preflightRequestShape, requestRaw);
  const request = requestRaw as PreflightRequestV1;
  const bundle = parsePortableInvestigation(bundleRaw, parseOptions);
  assertSafeIdentifiers(request);
  assertNoCredentialLeakage(request);

  const warnings: PreflightWarningV1[] = [];
  const referential: PreflightWarningV1[] = [];
  const mapBySource = new Map<string, IdentityMapEntryV1>();
  const destAssigned = new Map<string, string>();

  uniqueIds(
    "$.identityMap.sourceActorId",
    request.identityMap.map((row) => row.sourceActorId),
  );
  for (const [i, entry] of request.identityMap.entries()) {
    if (!bundle.actors.some((actor) => actor.sourceActorId === entry.sourceActorId)) {
      throw new ContractViolation(
        `$.identityMap[${i}].sourceActorId`,
        "identity-map ambiguity: source actor is not in the bundle",
      );
    }
    if (entry.action === "map_existing") {
      if (entry.destinationActorId === null) {
        throw new ContractViolation(
          `$.identityMap[${i}].destinationActorId`,
          "identity-map ambiguity: map_existing requires a destination actor id",
        );
      }
      const dest = request.destination.identities.find(
        (row) => row.actorId === entry.destinationActorId,
      );
      if (!dest) {
        referential.push({
          code: "missing_user",
          path: `$.identityMap[${i}].destinationActorId`,
          detail: "destination identity is not in the catalog",
        });
      }
      const previous = destAssigned.get(entry.destinationActorId);
      if (previous && previous !== entry.sourceActorId) {
        throw new ContractViolation(
          `$.identityMap[${i}].destinationActorId`,
          "identity-map ambiguity: two source actors map to the same destination",
        );
      }
      destAssigned.set(entry.destinationActorId, entry.sourceActorId);
    } else if (entry.destinationActorId !== null) {
      throw new ContractViolation(
        `$.identityMap[${i}].destinationActorId`,
        "identity-map ambiguity: destination id is only valid for map_existing",
      );
    }
    mapBySource.set(entry.sourceActorId, entry);
  }
  for (const actor of bundle.actors) {
    if (!mapBySource.has(actor.sourceActorId)) {
      throw new ContractViolation(
        "$.identityMap",
        "identity-map ambiguity: every source actor must be mapped explicitly",
      );
    }
    const destHit = request.destination.identities.find(
      (row) =>
        row.username === actor.username ||
        (actor.email !== null && row.email !== null && row.email === actor.email) ||
        row.displayName === actor.displayName,
    );
    const mapped = mapBySource.get(actor.sourceActorId);
    if (
      destHit &&
      mapped &&
      mapped.action !== "map_existing" &&
      mapped.destinationActorId === null
    ) {
      warnings.push({
        code: "identity_name_collision",
        path: `actor:${actor.sourceActorId}`,
        detail:
          "display name or email collides with a destination identity and was not used as a merge key",
      });
    }
  }

  const referencedProfiles = new Set<string>();
  for (const job of bundle.triageJobs) {
    for (const cand of job.candidates) {
      if (cand.profileId) referencedProfiles.add(cand.profileId);
    }
  }
  for (const run of bundle.importedAiRuns) {
    if (run.profileId) referencedProfiles.add(run.profileId);
  }
  const knownProfiles = new Set(request.destination.knownProfileIds);
  for (const profileId of referencedProfiles) {
    if (!knownProfiles.has(profileId)) {
      warnings.push({
        code: "missing_profile",
        path: `profile:${profileId}`,
        detail: "referenced provider profile is absent at the destination",
      });
    }
  }
  for (const ev of bundle.evidence) {
    if (ev.inclusion !== "present") {
      warnings.push({
        code: "missing_content",
        path: `evidence:${ev.id}`,
        detail: `content is ${ev.inclusion}`,
      });
    }
  }

  const idRemap: PreflightIdRemapV1[] = [];
  let create = 0;
  let conflict = 0;
  let blocked = referential.length;

  const idsByNamespace = portableNamespaceIds(bundle);
  const namespaces: Array<{ kind: PortableObjectKind; ids: string[] }> =
    PORTABLE_OBJECT_KINDS.map((kind) => ({
      kind,
      ids: [...idsByNamespace[kind]].sort(compareCodeUnits),
    }));

  for (const { kind, ids } of namespaces) {
    const existing = new Set(request.destination.objectIds[kind] ?? []);
    const occupied = new Set(existing);
    const seenRaw = new Set<string>();
    for (const sourceId of ids) {
      if (seenRaw.has(sourceId)) continue;
      seenRaw.add(sourceId);
      const destinationId = portableDestinationUuid(
        bundle.sourceInstallationId,
        kind,
        sourceId,
        0,
      );
      const collides = occupied.has(destinationId) || occupied.has(sourceId);
      if (!collides) {
        idRemap.push({ namespace: kind, sourceId, destinationId });
        occupied.add(destinationId);
        create += 1;
        continue;
      }
      if (request.collisionPolicy === "fail") {
        conflict += 1;
        blocked += 1;
        idRemap.push({ namespace: kind, sourceId, destinationId });
        referential.push({
          code: "id_collision",
          path: `${kind}:${sourceId}`,
          detail: "same raw id already exists at the destination",
        });
      } else {
        const remapped = chooseDeterministicRemap(
          bundle.sourceInstallationId,
          kind,
          sourceId,
          occupied,
        );
        idRemap.push({ namespace: kind, sourceId, destinationId: remapped });
        create += 1;
      }
    }
  }

  const reconstruction = evaluatePortableReconstruction({
    evidence: bundle.evidence,
    contentObjects: bundle.contentObjects,
    referentialIntegrityFailures: referential,
  });
  const catalogDigest = destinationCatalogDigest(request.destination);

  return {
    schemaId: PORTABLE_PREFLIGHT_SCHEMA_ID,
    semanticFingerprint: portableSemanticFingerprint(bundle),
    mode: "dry_run",
    bundleFingerprint: bundle.bundleFingerprint,
    sourceInstallationId: bundle.sourceInstallationId,
    counts: { create, update: 0, conflict, blocked },
    collisionPolicy: request.collisionPolicy,
    warnings,
    referentialIntegrityFailures: referential,
    idRemap,
    identityResolutions: [...mapBySource.values()].sort((a, b) =>
      compareCodeUnits(a.sourceActorId, b.sourceActorId),
    ),
    reconstructionStatus: reconstruction.reconstructionStatus,
    reconstructionReasons: reconstruction.reconstructionReasons,
    exactReconstruction: reconstruction.exactReconstruction,
    applyAuthorized: false,
    destinationCatalogDigest: catalogDigest,
    destinationCatalogIsAuthorization: false,
    destinationCatalogMustRevalidate: true,
    historicalParticipantsAreAttributionOnly: true,
    destinationMembershipGranted: false,
    destinationRoleGranted: false,
    destinationCapabilityGranted: false,
  };
}
