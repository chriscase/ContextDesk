/**
 * Versioned archive / apply-readiness projection for a portable investigation.
 * Pure JSON functions: no archive I/O, no Ed25519 verify, no persistence apply,
 * no authorization route, and no UI.
 */
import { createHash } from "node:crypto";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  COLLISION_POLICIES,
  MAX_DETERMINISTIC_REMAP_ATTEMPTS,
  PORTABLE_HISTORY_CAVEAT,
  PORTABLE_OBJECT_KINDS,
  PORTABLE_PERMISSION_CAVEAT,
  assertNoCredentialLeakage,
  canonicalJson,
  destinationCatalogDigest,
  evaluatePortableReconstruction,
  isRfc4122Uuid,
  parsePortableInvestigation,
  portableDestinationUuid,
  portableMintsDestinationId,
  portableSemanticFingerprint,
  preflightPortableInvestigation,
  sha256Text,
  type CollisionPolicy,
  type ContentInclusion,
  type DestinationCatalogV1,
  type IdentityMapEntryV1,
  type PortableHashEntryV1,
  type PortableInvestigationV1,
  type PortableObjectKind,
  type PreflightIdRemapV1,
  type PreflightReportV1,
  type PreflightRequestV1,
  type PreflightWarningV1,
  type ReconstructionReasonV1,
} from "./investigation-portable.js";

export {
  RFC4122_UUID_RE,
  PORTABLE_REMAP_NAMESPACE_UUID,
  isRfc4122Uuid,
  portableDestinationUuid,
} from "./investigation-portable.js";

export const PORTABLE_ARCHIVE_SCHEMA_ID =
  "cd-collab.investigation_portable_archive.v1" as const;
export const PORTABLE_ARCHIVE_PREFLIGHT_SCHEMA_ID =
  "cd-collab.investigation_portable_archive_preflight.v1" as const;

export const BLOB_PRESENCES = [
  "inline",
  "detached",
  "omitted",
  "private",
  "redacted",
] as const;
export type BlobPresence = (typeof BLOB_PRESENCES)[number];

export const ARCHIVE_SIGNATURE_ALGORITHMS = ["Ed25519"] as const;
export type ArchiveSignatureAlgorithm = (typeof ARCHIVE_SIGNATURE_ALGORITHMS)[number];

export const ARCHIVE_SIGNATURE_UNVERIFIED =
  "Signature metadata is recorded, not verified. This contract slice does not implement Ed25519 verification or source trust." as const;


export interface ArchiveBlobInventoryEntryV1 {
  digest: string;
  byteLength: number;
  contentType: string | null;
  presence: BlobPresence;
  payloadBase64: string | null;
}

export interface ArchiveHashInventoryEntryV1 {
  kind: string;
  id: string;
  hash: string;
}

export interface ArchiveSignatureMetadataV1 {
  algorithm: ArchiveSignatureAlgorithm;
  signingKeyFingerprint: string;
  signedManifestHash: string;
  hashInventory: ArchiveHashInventoryEntryV1[];
  signatureBase64: string | null;
  verificationStatus: "unverified";
  authenticityClaim: "none";
}

export interface PortableArchiveV1 {
  schemaId: typeof PORTABLE_ARCHIVE_SCHEMA_ID;
  exportedAt: string;
  semanticFingerprint: string;
  transportHash: string;
  permissionCaveat: typeof PORTABLE_PERMISSION_CAVEAT;
  historyCaveat: typeof PORTABLE_HISTORY_CAVEAT;
  blobInventory: ArchiveBlobInventoryEntryV1[];
  signature: ArchiveSignatureMetadataV1 | null;
  investigation: PortableInvestigationV1;
}

export interface ArchivePreflightRequestV1 {
  mode: "dry_run";
  collisionPolicy: CollisionPolicy;
  identityMap: IdentityMapEntryV1[];
  destination: DestinationCatalogV1;
  suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
}

export interface ArchivePreflightReportV1 {
  schemaId: typeof PORTABLE_ARCHIVE_PREFLIGHT_SCHEMA_ID;
  mode: "dry_run";
  semanticFingerprint: string;
  transportHash: string;
  bundleFingerprint: string;
  sourceInstallationId: string;
  counts: PreflightReportV1["counts"];
  collisionPolicy: CollisionPolicy;
  warnings: PreflightReportV1["warnings"];
  referentialIntegrityFailures: PreflightReportV1["referentialIntegrityFailures"];
  idRemap: PreflightIdRemapV1[];
  identityResolutions: IdentityMapEntryV1[];
  reconstructionStatus: PreflightReportV1["reconstructionStatus"];
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
  signatureVerificationStatus: "unverified" | "unsigned";
  authenticityClaim: "none";
}



const blobInventoryShape: ObjectShape = {
  digest: f.req(f.str),
  byteLength: f.req(f.u64),
  contentType: f.nul(f.str),
  presence: f.req(f.en(...BLOB_PRESENCES)),
  payloadBase64: f.nul(f.str),
};

const hashInventoryShape: ObjectShape = {
  kind: f.req(f.str),
  id: f.req(f.str),
  hash: f.req(f.str),
};

const signatureShape: ObjectShape = {
  algorithm: f.req(f.en(...ARCHIVE_SIGNATURE_ALGORITHMS)),
  signingKeyFingerprint: f.req(f.str),
  signedManifestHash: f.req(f.str),
  hashInventory: f.req(f.arr(f.obj(hashInventoryShape))),
  signatureBase64: f.nul(f.str),
  verificationStatus: f.req(f.en("unverified")),
  authenticityClaim: f.req(f.en("none")),
};

const archiveEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(PORTABLE_ARCHIVE_SCHEMA_ID)),
  exportedAt: f.req(f.str),
  semanticFingerprint: f.req(f.str),
  transportHash: f.req(f.str),
  permissionCaveat: f.req(f.en(PORTABLE_PERMISSION_CAVEAT)),
  historyCaveat: f.req(f.en(PORTABLE_HISTORY_CAVEAT)),
  blobInventory: f.req(f.arr(f.obj(blobInventoryShape))),
  signature: f.nul(f.obj(signatureShape)),
};

const destinationObjectIdsShape = Object.fromEntries(
  PORTABLE_OBJECT_KINDS.map((kind) => [kind, f.opt(f.arr(f.str))]),
) as ObjectShape;

const archivePreflightRequestShape: ObjectShape = {
  mode: f.req(f.en("dry_run")),
  collisionPolicy: f.req(f.en(...COLLISION_POLICIES)),
  identityMap: f.req(
    f.arr(
      f.obj({
        sourceActorId: f.req(f.str),
        action: f.req(f.str),
        destinationActorId: f.nul(f.str),
      }),
    ),
  ),
  destination: f.req(
    f.obj({
      identities: f.req(
        f.arr(
          f.obj({
            actorId: f.req(f.str),
            username: f.req(f.str),
            email: f.nul(f.str),
            displayName: f.req(f.str),
          }),
        ),
      ),
      objectIds: f.req(f.obj(destinationObjectIdsShape)),
      knownProfileIds: f.req(f.arr(f.str)),
    }),
  ),
  suppliedBlobs: f.opt(f.arr(f.obj(blobInventoryShape))),
};


const SHA256_HEX = /^[a-f0-9]{64}$/;
function requireSha256(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest");
  }
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inclusionToPresence(inclusion: ContentInclusion, hasPayload: boolean): BlobPresence {
  if (inclusion === "present") return hasPayload ? "inline" : "detached";
  return inclusion;
}

export function projectBlobInventory(
  investigation: PortableInvestigationV1,
): ArchiveBlobInventoryEntryV1[] {
  return [...investigation.contentObjects]
    .map((row) => ({
      digest: row.digest,
      byteLength: row.byteLength,
      contentType: row.contentType,
      presence: inclusionToPresence(row.inclusion, row.payloadBase64 !== null),
      payloadBase64: row.payloadBase64,
    }))
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
}

export function portableArchiveSignedManifestHash(input: {
  semanticFingerprint: string;
  blobInventory: ArchiveBlobInventoryEntryV1[];
  objectHashes: PortableHashEntryV1[];
}): string {
  return sha256Text(
    canonicalJson({
      semanticFingerprint: input.semanticFingerprint,
      blobInventory: input.blobInventory.map((row) => ({
        digest: row.digest,
        byteLength: row.byteLength,
        contentType: row.contentType,
        presence: row.presence,
      })),
      objectHashes: input.objectHashes,
    }),
  );
}

export function portableArchiveTransportHash(
  archive: Omit<PortableArchiveV1, "transportHash"> & { transportHash?: string },
): string {
  const { transportHash: _ignored, ...rest } = archive;
  return sha256Text(
    canonicalJson({
      schemaId: rest.schemaId,
      exportedAt: rest.exportedAt,
      semanticFingerprint: rest.semanticFingerprint,
      permissionCaveat: rest.permissionCaveat,
      historyCaveat: rest.historyCaveat,
      blobInventory: rest.blobInventory,
      signature: rest.signature,
      investigationBundleFingerprint: rest.investigation.bundleFingerprint,
    }),
  );
}

export function sealPortableArchive(input: {
  investigation: PortableInvestigationV1;
  exportedAt?: string;
  signature?: {
    signingKeyFingerprint: string;
    hashInventory: ArchiveHashInventoryEntryV1[];
    signatureBase64: string | null;
  } | null;
}): PortableArchiveV1 {
  const investigation = parsePortableInvestigation(input.investigation, {
    requireInlinePresentPayload: false,
  });
  const blobInventory = projectBlobInventory(investigation);
  const semanticFingerprint = portableSemanticFingerprint(investigation);
  const signedManifestHash = portableArchiveSignedManifestHash({
    semanticFingerprint,
    blobInventory,
    objectHashes: investigation.objectHashes,
  });
  const signature =
    input.signature == null
      ? null
      : {
          algorithm: "Ed25519" as const,
          signingKeyFingerprint: input.signature.signingKeyFingerprint,
          signedManifestHash,
          hashInventory: input.signature.hashInventory,
          signatureBase64: input.signature.signatureBase64,
          verificationStatus: "unverified" as const,
          authenticityClaim: "none" as const,
        };
  const unsigned = {
    schemaId: PORTABLE_ARCHIVE_SCHEMA_ID,
    exportedAt: input.exportedAt ?? investigation.exportedAt,
    semanticFingerprint,
    permissionCaveat: PORTABLE_PERMISSION_CAVEAT,
    historyCaveat: PORTABLE_HISTORY_CAVEAT,
    blobInventory,
    signature,
    investigation,
  };
  return {
    ...unsigned,
    transportHash: portableArchiveTransportHash(unsigned),
  };
}

function validateInventory(
  investigation: PortableInvestigationV1,
  inventory: ArchiveBlobInventoryEntryV1[],
): void {
  const byDigest = new Map<string, ArchiveBlobInventoryEntryV1>();
  for (const [i, row] of inventory.entries()) {
    requireSha256(`$.blobInventory[${i}].digest`, row.digest);
    if (byDigest.has(row.digest)) {
      throw new ContractViolation(`$.blobInventory[${i}].digest`, "duplicate digest");
    }
    byDigest.set(row.digest, row);
    if (row.presence === "inline") {
      if (row.payloadBase64 === null) {
        throw new ContractViolation(
          `$.blobInventory[${i}].payloadBase64`,
          "inline presence requires payload bytes",
        );
      }
    } else if (row.payloadBase64 !== null) {
      throw new ContractViolation(
        `$.blobInventory[${i}].payloadBase64`,
        "non-inline presence must not include payload",
      );
    }
    if (row.payloadBase64 !== null) {
      const bytes = Buffer.from(row.payloadBase64, "base64");
      if (bytes.byteLength !== row.byteLength) {
        throw new ContractViolation(`$.blobInventory[${i}].byteLength`, "payload length mismatch");
      }
      if (sha256Bytes(bytes) !== row.digest) {
        throw new ContractViolation(`$.blobInventory[${i}].digest`, "hash/fingerprint mismatch");
      }
    }
  }
  for (const [i, row] of investigation.contentObjects.entries()) {
    const item = byDigest.get(row.digest);
    if (!item) {
      throw new ContractViolation(
        `$.investigation.contentObjects[${i}].digest`,
        "missing blob inventory",
      );
    }
    if (item.byteLength !== row.byteLength) {
      throw new ContractViolation(`$.blobInventory digest=${row.digest}`, "byteLength mismatch");
    }
    if (item.contentType !== row.contentType) {
      throw new ContractViolation(`$.blobInventory digest=${row.digest}`, "contentType mismatch");
    }
    if (row.inclusion === "present") {
      if (item.presence !== "inline" && item.presence !== "detached") {
        throw new ContractViolation(
          `$.blobInventory digest=${row.digest}`,
          "present content must be inline or detached in inventory",
        );
      }
    } else if (item.presence !== row.inclusion) {
      throw new ContractViolation(
        `$.blobInventory digest=${row.digest}`,
        "presence does not match content inclusion",
      );
    }
  }
}

function validateSignature(archive: PortableArchiveV1): void {
  const signature = archive.signature;
  if (signature === null) return;
  requireSha256("$.signature.signingKeyFingerprint", signature.signingKeyFingerprint);
  requireSha256("$.signature.signedManifestHash", signature.signedManifestHash);
  if (signature.verificationStatus !== "unverified" || signature.authenticityClaim !== "none") {
    throw new ContractViolation(
      "$.signature",
      "this contract slice records signature metadata without verification or source trust",
    );
  }
  const expected = portableArchiveSignedManifestHash({
    semanticFingerprint: archive.semanticFingerprint,
    blobInventory: archive.blobInventory,
    objectHashes: archive.investigation.objectHashes,
  });
  if (signature.signedManifestHash !== expected) {
    throw new ContractViolation("$.signature.signedManifestHash", "hash/fingerprint mismatch");
  }
  for (const [i, row] of signature.hashInventory.entries()) {
    requireSha256(`$.signature.hashInventory[${i}].hash`, row.hash);
    if (!row.kind.trim() || !row.id.trim()) {
      throw new ContractViolation(`$.signature.hashInventory[${i}]`, "kind and id must not be empty");
    }
  }
}

export function parsePortableArchive(raw: unknown): PortableArchiveV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation("$", "expected object");
  }
  const record = { ...(raw as Record<string, unknown>) };
  const investigationRaw = record.investigation;
  delete record.investigation;
  checkObject("$", archiveEnvelopeShape, record);
  assertNoCredentialLeakage(raw);
  const investigation = parsePortableInvestigation(investigationRaw, {
    requireInlinePresentPayload: false,
  });
  const row = raw as PortableArchiveV1;
  const expectedSemantic = portableSemanticFingerprint(investigation);
  if (row.semanticFingerprint !== expectedSemantic) {
    throw new ContractViolation("$.semanticFingerprint", "hash/fingerprint mismatch");
  }
  validateInventory(investigation, row.blobInventory);
  const archive: PortableArchiveV1 = { ...row, investigation };
  validateSignature(archive);
  const expectedTransport = portableArchiveTransportHash(archive);
  if (row.transportHash !== expectedTransport) {
    throw new ContractViolation("$.transportHash", "hash/fingerprint mismatch");
  }
  return archive;
}

function chooseUuidRemap(
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

function uuidIdRemap(
  investigation: PortableInvestigationV1,
  destination: DestinationCatalogV1,
  collisionPolicy: CollisionPolicy,
  v1Report: PreflightReportV1,
): {
  idRemap: PreflightIdRemapV1[];
  conflict: number;
  blocked: number;
  create: number;
  collisionFailures: PreflightWarningV1[];
} {
  const idRemap: PreflightIdRemapV1[] = [];
  const collisionFailures: PreflightWarningV1[] = [];
  let conflict = 0;
  let blocked = 0;
  let create = 0;
  for (const kind of PORTABLE_OBJECT_KINDS) {
    const sourceIds = v1Report.idRemap
      .filter((row) => row.namespace === kind)
      .map((row) => row.sourceId);
    // Occupied destination UUID space only. A raw source id echoed back by the
    // destination catalog is not a destination key and must not narrow the
    // deterministic ladder.
    const occupied = new Set(
      (destination.objectIds[kind] ?? []).filter((id) => isRfc4122Uuid(id)),
    );
    for (const sourceId of sourceIds) {
      const first = portableDestinationUuid(investigation.sourceInstallationId, kind, sourceId, 0);
      if (!portableMintsDestinationId(kind)) {
        // Content digests deduplicate and timeline sequences are reassigned by
        // the destination; neither keys a destination row, so neither can
        // collide and neither consumes deterministic ladder space.
        idRemap.push({ namespace: kind, sourceId, destinationId: first });
        create += 1;
        continue;
      }
      if (occupied.has(first) && collisionPolicy === "fail") {
        conflict += 1;
        blocked += 1;
        idRemap.push({ namespace: kind, sourceId, destinationId: first });
        collisionFailures.push({
          code: "id_collision",
          path: `${kind}:${sourceId}`,
          detail: "deterministic destination UUID already exists",
        });
        continue;
      }
      const destinationId = chooseUuidRemap(
        investigation.sourceInstallationId,
        kind,
        sourceId,
        occupied,
      );
      idRemap.push({ namespace: kind, sourceId, destinationId });
      create += 1;
    }
  }
  return { idRemap, conflict, blocked, create, collisionFailures };
}

function effectiveContentObjects(
  archive: PortableArchiveV1,
  suppliedBlobs: ArchiveBlobInventoryEntryV1[],
): Array<{
  digest: string;
  inclusion: ContentInclusion;
  payloadBase64: string | null;
  byteLength: number;
}> {
  const supplied = new Map(suppliedBlobs.map((row) => [row.digest, row]));
  const inventory = new Map(archive.blobInventory.map((row) => [row.digest, row]));
  return archive.investigation.contentObjects.map((row) => ({
    digest: row.digest,
    inclusion: row.inclusion,
    byteLength: row.byteLength,
    payloadBase64:
      inventory.get(row.digest)?.payloadBase64 ??
      supplied.get(row.digest)?.payloadBase64 ??
      row.payloadBase64 ??
      null,
  }));
}

export function preflightPortableArchive(
  archiveRaw: unknown,
  requestRaw: unknown,
): ArchivePreflightReportV1 {
  if (
    typeof requestRaw === "object" &&
    requestRaw !== null &&
    "mode" in requestRaw &&
    (requestRaw as { mode: unknown }).mode !== "dry_run"
  ) {
    throw new ContractViolation("$.mode", "dry-run is required before apply");
  }
  checkObject("$", archivePreflightRequestShape, requestRaw);
  const request = requestRaw as ArchivePreflightRequestV1;
  assertNoCredentialLeakage(request);
  const archive = parsePortableArchive(archiveRaw);
  const v1Request: PreflightRequestV1 = {
    mode: "dry_run",
    collisionPolicy: request.collisionPolicy,
    identityMap: request.identityMap,
    destination: request.destination,
  };
  const v1Report = preflightPortableInvestigation(archive.investigation, v1Request, {
    requireInlinePresentPayload: false,
  });
  const uuidRemap = uuidIdRemap(
    archive.investigation,
    request.destination,
    request.collisionPolicy,
    v1Report,
  );
  const referential = [
    ...v1Report.referentialIntegrityFailures,
    ...uuidRemap.collisionFailures,
  ];
  const reconstruction = evaluatePortableReconstruction({
    evidence: archive.investigation.evidence,
    contentObjects: effectiveContentObjects(archive, request.suppliedBlobs ?? []),
    referentialIntegrityFailures: referential,
  });
  const blobBlocked = reconstruction.reconstructionReasons.filter((row) =>
    row.code === "declared_present_bytes_missing" ||
    row.code === "declared_present_digest_mismatch" ||
    row.code === "declared_present_length_mismatch"
  ).length;
  const blocked =
    v1Report.counts.blocked + blobBlocked + (request.collisionPolicy === "fail" ? uuidRemap.blocked : 0);
  return {
    schemaId: PORTABLE_ARCHIVE_PREFLIGHT_SCHEMA_ID,
    mode: "dry_run",
    semanticFingerprint: archive.semanticFingerprint,
    transportHash: archive.transportHash,
    bundleFingerprint: archive.investigation.bundleFingerprint,
    sourceInstallationId: archive.investigation.sourceInstallationId,
    counts: {
      create: uuidRemap.create,
      update: 0,
      conflict: uuidRemap.conflict,
      blocked,
    },
    collisionPolicy: request.collisionPolicy,
    warnings: v1Report.warnings,
    referentialIntegrityFailures: referential,
    idRemap: uuidRemap.idRemap,
    identityResolutions: v1Report.identityResolutions,
    reconstructionStatus: reconstruction.reconstructionStatus,
    reconstructionReasons: reconstruction.reconstructionReasons,
    exactReconstruction: reconstruction.exactReconstruction,
    applyAuthorized: false,
    destinationCatalogDigest: destinationCatalogDigest(request.destination),
    destinationCatalogIsAuthorization: false,
    destinationCatalogMustRevalidate: true,
    historicalParticipantsAreAttributionOnly: true,
    destinationMembershipGranted: false,
    destinationRoleGranted: false,
    destinationCapabilityGranted: false,
    signatureVerificationStatus: archive.signature ? "unverified" : "unsigned",
    authenticityClaim: "none",
  };
}

export function historicalRolesAreAttributionOnly(
  report: Pick<
    ArchivePreflightReportV1,
    | "historicalParticipantsAreAttributionOnly"
    | "destinationMembershipGranted"
    | "destinationRoleGranted"
    | "destinationCapabilityGranted"
  >,
): boolean {
  return (
    report.historicalParticipantsAreAttributionOnly === true &&
    report.destinationMembershipGranted === false &&
    report.destinationRoleGranted === false &&
    report.destinationCapabilityGranted === false
  );
}
