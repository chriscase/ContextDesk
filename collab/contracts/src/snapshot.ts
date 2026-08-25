import { createHash } from "node:crypto";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { assertShareSafeFingerprint, assertShareSafeTimestamp } from "./privacy.js";

export const SNAPSHOT_SCHEMA_ID = "cd-collab.snapshot.v1" as const;
export const SNAPSHOT_LIST_SCHEMA_ID = "cd-collab.snapshot_list.v1" as const;
export const SNAPSHOT_STATUSES = ["frozen"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const SNAPSHOT_FAIRNESS_CLASSES = ["same_snapshot", "unknown"] as const;
export type SnapshotFairnessClass = (typeof SNAPSHOT_FAIRNESS_CLASSES)[number];

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface SnapshotEvidenceV1 {
  evidenceId: string;
  ordinal: number;
  contentHash: string | null;
  expectedHash: string | null;
  verificationStatus: string | null;
  privacyClass: PrivacyClass;
}

export interface SnapshotV1 {
  schemaId: typeof SNAPSHOT_SCHEMA_ID;
  id: string;
  caseId: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  evidence: SnapshotEvidenceV1[];
  visibility: PrivacyClass;
  protocolVersion: string;
  fairnessClass: SnapshotFairnessClass;
  status: SnapshotStatus;
  createdAt: string;
  createdBy: string;
}

export interface SnapshotListV1 {
  schemaId: typeof SNAPSHOT_LIST_SCHEMA_ID;
  caseId: string;
  snapshots: SnapshotV1[];
}

const snapshotEvidenceShape: ObjectShape = {
  evidenceId: f.req(f.str),
  ordinal: f.req(f.u64),
  contentHash: f.nul(f.str),
  expectedHash: f.nul(f.str),
  verificationStatus: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

const snapshotShape: ObjectShape = {
  schemaId: f.req(f.en(SNAPSHOT_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  fingerprint: f.req(f.str),
  parentSnapshotId: f.nul(f.str),
  evidence: f.req(f.arr(f.obj(snapshotEvidenceShape))),
  visibility: f.req(f.en(...PRIVACY_CLASSES)),
  protocolVersion: f.req(f.str),
  fairnessClass: f.req(f.en(...SNAPSHOT_FAIRNESS_CLASSES)),
  status: f.req(f.en(...SNAPSHOT_STATUSES)),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
};

const snapshotListShape: ObjectShape = {
  schemaId: f.req(f.en(SNAPSHOT_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  snapshots: f.req(f.arr(f.obj(snapshotShape))),
};

export interface SnapshotFingerprintInput {
  parentSnapshotId: string | null;
  evidence: Pick<
    SnapshotEvidenceV1,
    "evidenceId" | "ordinal" | "contentHash" | "expectedHash" | "verificationStatus" | "privacyClass"
  >[];
  visibility: PrivacyClass;
  protocolVersion: string;
}

function requireContentHash(path: string, value: string | null): void {
  if (value === null) return;
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest or null");
  }
}

export function canonicalSnapshotEvidence(
  evidence: SnapshotFingerprintInput["evidence"],
): SnapshotFingerprintInput["evidence"] {
  return [...evidence]
    .map((item) => ({
      evidenceId: item.evidenceId,
      ordinal: item.ordinal,
      contentHash: item.contentHash,
      expectedHash: item.expectedHash,
      verificationStatus: item.verificationStatus,
      privacyClass: item.privacyClass,
    }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * Produce the stable identity of exactly what a triage attempt could see.
 * Evidence order is canonicalized by identity; ordinal remains part of the
 * input so callers cannot silently change packet ordering without a new id.
 */
export function snapshotFingerprint(input: SnapshotFingerprintInput): string {
  const canonical = JSON.stringify({
    parentSnapshotId: input.parentSnapshotId,
    evidence: canonicalSnapshotEvidence(input.evidence),
    visibility: input.visibility,
    protocolVersion: input.protocolVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function snapshotItemContentHash(input: {
  contentHash: string | null;
  expectedHash: string | null;
}): string | null {
  return input.contentHash ?? input.expectedHash;
}

/**
 * Whether every item has a hash so input equality can be established.
 * Missing hashes stay unknown; this helper does not rewrite stored documents.
 */
export function snapshotFairness(evidence: readonly SnapshotEvidenceV1[]): SnapshotFairnessClass {
  if (evidence.length === 0) return "same_snapshot";
  return evidence.every((item) => snapshotItemContentHash(item) !== null)
    ? "same_snapshot"
    : "unknown";
}

/**
 * Canonical SHA-256 digest for snapshot identity comparison.
 * Accepts a bare hex digest or a `snap-` prefixed fingerprint.
 * Unverifiable values return null and must never be treated as a match.
 */
export function snapshotFingerprintDigest(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const digest = normalized.startsWith("snap-") ? normalized.slice("snap-".length) : normalized;
  return SHA256_HEX.test(digest) ? digest : null;
}

export function parseSnapshot(raw: unknown): SnapshotV1 {
  checkObject("$", snapshotShape, raw);
  const row = raw as SnapshotV1;
  if (!row.id.trim()) {
    throw new ContractViolation("$.id", "must not be empty");
  }
  if (!row.caseId.trim()) {
    throw new ContractViolation("$.caseId", "must not be empty");
  }
  if (row.parentSnapshotId !== null) {
    if (!row.parentSnapshotId.trim()) {
      throw new ContractViolation("$.parentSnapshotId", "must not be empty when present");
    }
    if (row.parentSnapshotId === row.id) {
      throw new ContractViolation("$.parentSnapshotId", "must not reference the snapshot itself");
    }
  }
  if (!row.protocolVersion.trim()) {
    throw new ContractViolation("$.protocolVersion", "must not be empty");
  }
  const seenIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  for (const [i, item] of row.evidence.entries()) {
    if (!item.evidenceId.trim()) {
      throw new ContractViolation(`$.evidence[${i}].evidenceId`, "must not be empty");
    }
    if (seenIds.has(item.evidenceId)) {
      throw new ContractViolation(`$.evidence[${i}].evidenceId`, "duplicate evidenceId");
    }
    seenIds.add(item.evidenceId);
    if (seenOrdinals.has(item.ordinal)) {
      throw new ContractViolation(`$.evidence[${i}].ordinal`, "duplicate ordinal");
    }
    seenOrdinals.add(item.ordinal);
    requireContentHash(`$.evidence[${i}].contentHash`, item.contentHash);
    requireContentHash(`$.evidence[${i}].expectedHash`, item.expectedHash);
    if (row.visibility === "share_safe" && item.privacyClass !== "share_safe") {
      throw new ContractViolation(
        `$.evidence[${i}].privacyClass`,
        "share-safe snapshot cannot include owner-only evidence",
      );
    }
  }
  assertShareSafeFingerprint("$.fingerprint", row.fingerprint);
  const expected = snapshotFingerprint({
    parentSnapshotId: row.parentSnapshotId,
    evidence: row.evidence,
    visibility: row.visibility,
    protocolVersion: row.protocolVersion,
  });
  if (row.fingerprint !== expected) {
    throw new ContractViolation("$.fingerprint", "must match the canonical snapshot fingerprint");
  }
  assertShareSafeTimestamp("$.createdAt", row.createdAt);
  if (!row.createdBy.trim()) {
    throw new ContractViolation("$.createdBy", "creator identity is required");
  }
  return row;
}

export function parseSnapshotList(raw: unknown): SnapshotListV1 {
  checkObject("$", snapshotListShape, raw);
  const row = raw as SnapshotListV1;
  if (!row.caseId.trim()) {
    throw new ContractViolation("$.caseId", "must not be empty");
  }
  return {
    ...row,
    snapshots: row.snapshots.map((snapshot) => parseSnapshot(snapshot)),
  };
}
