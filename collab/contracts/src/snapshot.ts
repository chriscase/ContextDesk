import { createHash } from "node:crypto";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafeFingerprint, assertShareSafeTimestamp } from "./privacy.js";

export const SNAPSHOT_SCHEMA_ID = "cd-collab.snapshot.v1" as const;

export const SNAPSHOT_ITEM_VISIBILITIES = ["strategy_visible", "hidden"] as const;
export type SnapshotItemVisibility = (typeof SNAPSHOT_ITEM_VISIBILITIES)[number];

export const SNAPSHOT_FAIRNESS = ["same_snapshot", "unknown_visibility"] as const;
export type SnapshotFairness = (typeof SNAPSHOT_FAIRNESS)[number];

export const SNAPSHOT_STATUSES = ["frozen"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const DEFAULT_SNAPSHOT_VISIBILITY_POLICY = {
  includeSummaries: false,
  includeRawBytes: true,
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface SnapshotVisibilityPolicyV1 {
  includeSummaries: boolean;
  includeRawBytes: boolean;
}

export interface SnapshotItemV1 {
  evidenceId: string;
  contentHash: string | null;
  visibility: SnapshotItemVisibility;
  privacyClass: PrivacyClass;
}

export interface SnapshotV1 {
  schemaId: typeof SNAPSHOT_SCHEMA_ID;
  snapshotId: string;
  caseId: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  items: SnapshotItemV1[];
  visibilityPolicy: SnapshotVisibilityPolicyV1;
  protocolId: string | null;
  protocolVersion: string | null;
  fairness: SnapshotFairness;
  status: SnapshotStatus;
  privacyClass: "owner_only";
  createdAt: string;
  createdBy: string;
  createdByUsername: string;
}

export interface SnapshotFingerprintInput {
  caseId: string;
  parentSnapshotId: string | null;
  items: readonly SnapshotItemV1[];
  visibilityPolicy: SnapshotVisibilityPolicyV1;
  protocolId: string | null;
  protocolVersion: string | null;
}

const visibilityPolicyShape: ObjectShape = {
  includeSummaries: f.req(f.bool),
  includeRawBytes: f.req(f.bool),
};

const snapshotItemShape: ObjectShape = {
  evidenceId: f.req(f.str),
  contentHash: f.nul(f.str),
  visibility: f.req(f.en(...SNAPSHOT_ITEM_VISIBILITIES)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

export const snapshotShape: ObjectShape = {
  schemaId: f.req(f.en(SNAPSHOT_SCHEMA_ID)),
  snapshotId: f.req(f.str),
  caseId: f.req(f.str),
  fingerprint: f.req(f.str),
  parentSnapshotId: f.nul(f.str),
  items: f.req(f.arr(f.obj(snapshotItemShape))),
  visibilityPolicy: f.req(f.obj(visibilityPolicyShape)),
  protocolId: f.nul(f.str),
  protocolVersion: f.nul(f.str),
  fairness: f.req(f.en(...SNAPSHOT_FAIRNESS)),
  status: f.req(f.en(...SNAPSHOT_STATUSES)),
  privacyClass: f.req(f.en("owner_only")),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  createdByUsername: f.req(f.str),
};

function requireUuid(path: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected a UUID");
  }
}

function requireContentHash(path: string, value: string | null): void {
  if (value === null) return;
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest or null");
  }
}

export function canonicalSnapshotItems(items: readonly SnapshotItemV1[]): SnapshotItemV1[] {
  return [...items]
    .map((item) => ({
      evidenceId: item.evidenceId,
      contentHash: item.contentHash,
      visibility: item.visibility,
      privacyClass: item.privacyClass,
    }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

export function snapshotFingerprint(input: SnapshotFingerprintInput): string {
  const canonical = JSON.stringify({
    caseId: input.caseId,
    parentSnapshotId: input.parentSnapshotId,
    items: canonicalSnapshotItems(input.items),
    visibilityPolicy: {
      includeSummaries: input.visibilityPolicy.includeSummaries,
      includeRawBytes: input.visibilityPolicy.includeRawBytes,
    },
    protocolId: input.protocolId,
    protocolVersion: input.protocolVersion,
  });
  return `snap-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function snapshotFairness(items: readonly SnapshotItemV1[]): SnapshotFairness {
  const visible = items.filter((item) => item.visibility === "strategy_visible");
  if (visible.length === 0) return "unknown_visibility";
  return visible.every((item) => item.contentHash !== null)
    ? "same_snapshot"
    : "unknown_visibility";
}

export function snapshotItemContentHash(input: {
  contentHash: string | null;
  expectedHash: string | null;
}): string | null {
  return input.contentHash ?? input.expectedHash;
}

export function parseSnapshot(raw: unknown): SnapshotV1 {
  checkObject("$", snapshotShape, raw);
  const row = raw as SnapshotV1;
  requireUuid("$.snapshotId", row.snapshotId);
  if (!row.caseId.trim()) {
    throw new ContractViolation("$.caseId", "must not be empty");
  }
  if (row.parentSnapshotId !== null) {
    requireUuid("$.parentSnapshotId", row.parentSnapshotId);
    if (row.parentSnapshotId === row.snapshotId) {
      throw new ContractViolation("$.parentSnapshotId", "must not reference the snapshot itself");
    }
  }
  if (row.items.length === 0) {
    throw new ContractViolation("$.items", "at least one evidence item is required");
  }
  const seen = new Set<string>();
  for (const [i, item] of row.items.entries()) {
    if (!item.evidenceId.trim()) {
      throw new ContractViolation(`$.items[${i}].evidenceId`, "must not be empty");
    }
    if (seen.has(item.evidenceId)) {
      throw new ContractViolation(`$.items[${i}].evidenceId`, "duplicate evidenceId");
    }
    seen.add(item.evidenceId);
    requireContentHash(`$.items[${i}].contentHash`, item.contentHash);
  }
  if (row.protocolId !== null && !row.protocolId.trim()) {
    throw new ContractViolation("$.protocolId", "must not be empty when present");
  }
  if (row.protocolVersion !== null && !row.protocolVersion.trim()) {
    throw new ContractViolation("$.protocolVersion", "must not be empty when present");
  }
  assertShareSafeFingerprint("$.fingerprint", row.fingerprint);
  if (!row.fingerprint.startsWith("snap-")) {
    throw new ContractViolation("$.fingerprint", "expected a snap- SHA-256 fingerprint");
  }
  const expected = snapshotFingerprint(row);
  if (row.fingerprint !== expected) {
    throw new ContractViolation("$.fingerprint", "must match the canonical snapshot fingerprint");
  }
  const fairness = snapshotFairness(row.items);
  if (row.fairness !== fairness) {
    throw new ContractViolation("$.fairness", `must be ${fairness} for these items`);
  }
  assertShareSafeTimestamp("$.createdAt", row.createdAt);
  if (!row.createdBy.trim() || !row.createdByUsername.trim()) {
    throw new ContractViolation("$", "creator identity is required");
  }
  return row;
}
