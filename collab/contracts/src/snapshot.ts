import { createHash } from "node:crypto";
import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";

export const SNAPSHOT_SCHEMA_ID = "cd-collab.snapshot.v1" as const;
export const SNAPSHOT_LIST_SCHEMA_ID = "cd-collab.snapshot_list.v1" as const;
export const SNAPSHOT_STATUSES = ["frozen"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const SNAPSHOT_FAIRNESS_CLASSES = ["same_snapshot", "unknown"] as const;
export type SnapshotFairnessClass = (typeof SNAPSHOT_FAIRNESS_CLASSES)[number];

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

export function parseSnapshot(raw: unknown): SnapshotV1 {
  checkObject("$", snapshotShape, raw);
  return raw as SnapshotV1;
}

const snapshotListShape: ObjectShape = {
  schemaId: f.req(f.en(SNAPSHOT_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  snapshots: f.req(f.arr(f.obj(snapshotShape))),
};

export function parseSnapshotList(raw: unknown): SnapshotListV1 {
  checkObject("$", snapshotListShape, raw);
  return raw as SnapshotListV1;
}

export interface SnapshotFingerprintInput {
  parentSnapshotId: string | null;
  evidence: Pick<
    SnapshotEvidenceV1,
    "evidenceId" | "ordinal" | "contentHash" | "expectedHash" | "verificationStatus" | "privacyClass"
  >[];
  visibility: PrivacyClass;
  protocolVersion: string;
}

/**
 * Produce the stable identity of exactly what a triage attempt could see.
 * Evidence order is canonicalized by identity; ordinal remains part of the
 * input so callers cannot silently change packet ordering without a new id.
 */
export function snapshotFingerprint(input: SnapshotFingerprintInput): string {
  const canonical = JSON.stringify({
    parentSnapshotId: input.parentSnapshotId,
    evidence: [...input.evidence]
      .map((item) => ({
        evidenceId: item.evidenceId,
        ordinal: item.ordinal,
        contentHash: item.contentHash,
        expectedHash: item.expectedHash,
        verificationStatus: item.verificationStatus,
        privacyClass: item.privacyClass,
      }))
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
    visibility: input.visibility,
    protocolVersion: input.protocolVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
