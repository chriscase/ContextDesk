/**
 * Fail-closed apply request/response contract for a portable investigation archive.
 * Intent minting and persistence are host concerns; this module only validates JSON.
 */
import { canonicalJson, sha256Text } from "./investigation-portable.js";
import { COLLISION_POLICIES, IDENTITY_ACTIONS } from "./investigation-portable.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { assertNoCredentialLeakage } from "./investigation-portable.js";

export const PORTABLE_APPLY_REQUEST_SCHEMA_ID =
  "cd-collab.portable_investigation_apply_request.v1" as const;
export const PORTABLE_APPLY_RESPONSE_SCHEMA_ID =
  "cd-collab.portable_investigation_apply_response.v1" as const;
export const PORTABLE_APPLY_TYPED_CONFIRMATION = "RESTORE" as const;

export interface PortableApplyRequestV1 {
  schemaId: typeof PORTABLE_APPLY_REQUEST_SCHEMA_ID;
  confirmationToken: string;
  typedConfirmation: typeof PORTABLE_APPLY_TYPED_CONFIRMATION;
  collisionPolicy: (typeof COLLISION_POLICIES)[number];
  identityMap: {
    sourceActorId: string;
    action: (typeof IDENTITY_ACTIONS)[number];
    destinationActorId: string | null;
  }[];
  archive: unknown;
  suppliedBlobs?: unknown[];
}

export interface PortableApplyResponseV1 {
  schemaId: typeof PORTABLE_APPLY_RESPONSE_SCHEMA_ID;
  status: "applied" | "idempotent_replay";
  investigationId: string;
  deepLink: string;
  transportHash: string;
  semanticFingerprint: string;
  destinationCatalogDigest: string;
  authenticityClaim: "none";
  destinationMembershipGranted: false;
  destinationRoleGranted: false;
  destinationCapabilityGranted: false;
}

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(PORTABLE_APPLY_REQUEST_SCHEMA_ID)),
  confirmationToken: f.req(f.str),
  typedConfirmation: f.req(f.en(PORTABLE_APPLY_TYPED_CONFIRMATION)),
  collisionPolicy: f.req(f.en(...COLLISION_POLICIES)),
  identityMap: f.req(
    f.arr(
      f.obj({
        sourceActorId: f.req(f.str),
        action: f.req(f.en(...IDENTITY_ACTIONS)),
        destinationActorId: f.nul(f.str),
      }),
    ),
  ),
  archive: f.req(f.obj({})),
  suppliedBlobs: f.opt(f.arr(f.obj({}))),
};

const responseShape: ObjectShape = {
  schemaId: f.req(f.en(PORTABLE_APPLY_RESPONSE_SCHEMA_ID)),
  status: f.req(f.en("applied", "idempotent_replay")),
  investigationId: f.req(f.str),
  deepLink: f.req(f.str),
  transportHash: f.req(f.str),
  semanticFingerprint: f.req(f.str),
  destinationCatalogDigest: f.req(f.str),
  authenticityClaim: f.req(f.en("none")),
  destinationMembershipGranted: f.req(f.bool),
  destinationRoleGranted: f.req(f.bool),
  destinationCapabilityGranted: f.req(f.bool),
};

export function identityMapDigest(
  identityMap: PortableApplyRequestV1["identityMap"],
): string {
  const sorted = [...identityMap]
    .map((row) => ({
      sourceActorId: row.sourceActorId,
      action: row.action,
      destinationActorId: row.destinationActorId,
    }))
    .sort((a, b) => a.sourceActorId.localeCompare(b.sourceActorId));
  return sha256Text(canonicalJson(sorted));
}

export function parsePortableApplyRequest(raw: unknown): PortableApplyRequestV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation("$", "expected object");
  }
  const row = raw as Record<string, unknown>;
  const archive = row.archive;
  const suppliedBlobs = row.suppliedBlobs;
  const withoutOpaque = { ...row };
  delete withoutOpaque.archive;
  delete withoutOpaque.suppliedBlobs;
  checkObject("$", {
    ...requestShape,
    archive: f.opt(f.obj({})),
    suppliedBlobs: f.opt(f.arr(f.obj({}))),
  }, { ...withoutOpaque, archive: {}, ...(suppliedBlobs !== undefined ? { suppliedBlobs: [] } : {}) });
  if (!("archive" in row)) {
    throw new ContractViolation("$.archive", "missing required key");
  }
  if (typeof archive !== "object" || archive === null || Array.isArray(archive)) {
    throw new ContractViolation("$.archive", "expected object");
  }
  if (typeof row.confirmationToken !== "string" || !row.confirmationToken.trim()) {
    throw new ContractViolation("$.confirmationToken", "must not be empty");
  }
  assertNoCredentialLeakage({
    schemaId: row.schemaId,
    confirmationToken: row.confirmationToken,
    typedConfirmation: row.typedConfirmation,
    collisionPolicy: row.collisionPolicy,
    identityMap: row.identityMap,
  });
  return {
    schemaId: PORTABLE_APPLY_REQUEST_SCHEMA_ID,
    confirmationToken: row.confirmationToken as string,
    typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
    collisionPolicy: row.collisionPolicy as PortableApplyRequestV1["collisionPolicy"],
    identityMap: row.identityMap as PortableApplyRequestV1["identityMap"],
    archive,
    ...(Array.isArray(suppliedBlobs) ? { suppliedBlobs } : {}),
  };
}

export function parsePortableApplyResponse(raw: unknown): PortableApplyResponseV1 {
  checkObject("$", responseShape, raw);
  const row = raw as PortableApplyResponseV1;
  if (!row.investigationId.trim()) {
    throw new ContractViolation("$.investigationId", "must not be empty");
  }
  if (!row.deepLink.startsWith("/investigations/")) {
    throw new ContractViolation("$.deepLink", "expected /investigations/{id}/situation");
  }
  if (
    row.destinationMembershipGranted !== false ||
    row.destinationRoleGranted !== false ||
    row.destinationCapabilityGranted !== false
  ) {
    throw new ContractViolation("$", "apply must not grant destination membership, roles, or capabilities");
  }
  return row;
}

export function portableApplyDeepLink(investigationId: string): string {
  return `/investigations/${investigationId}/situation`;
}
