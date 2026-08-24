import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import * as contractBarrel from "./index.js";
import { ContractViolation } from "./parse.js";
import {
  attachPortableIntegrity,
  parsePortableInvestigation,
  portableSemanticFingerprint,
  type PortableInvestigationUnsigned,
  type PortableInvestigationV1,
  type PreflightRequestV1,
} from "./investigation-portable.js";
import {
  RFC4122_UUID_RE,
  historicalRolesAreAttributionOnly,
  isRfc4122Uuid,
  parsePortableArchive,
  portableDestinationUuid,
  preflightPortableArchive,
  sealPortableArchive,
  PORTABLE_ARCHIVE_PREFLIGHT_SCHEMA_ID,
  PORTABLE_ARCHIVE_SCHEMA_ID,
} from "./investigation-portable-archive.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const schemasDir = join(here, "..", "schemas");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

function valid(): PortableInvestigationV1 {
  return structuredClone(load("investigation-portable.valid.json")) as PortableInvestigationV1;
}

function unsignedOf(bundle: PortableInvestigationV1): PortableInvestigationUnsigned {
  const { bundleFingerprint: _fp, objectHashes: _hashes, ...rest } = bundle;
  return rest;
}

function identityMapFor(bundle: PortableInvestigationV1): PreflightRequestV1["identityMap"] {
  return bundle.actors.map((actor) => ({
    sourceActorId: actor.sourceActorId,
    action: "leave_unresolved" as const,
    destinationActorId: null,
  }));
}

function archiveDryRun(
  bundle: PortableInvestigationV1,
  overlay: Partial<Parameters<typeof preflightPortableArchive>[1]> = {},
) {
  return {
    mode: "dry_run" as const,
    collisionPolicy: "remap_deterministic" as const,
    identityMap: identityMapFor(bundle),
    destination: { identities: [], objectIds: {}, knownProfileIds: ["profile-synth"] },
    ...overlay,
  };
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function allPresentBundle(): PortableInvestigationV1 {
  const bundle = valid();
  const bytes = Buffer.from("synth-owner-notes-v1", "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const privateEv = bundle.evidence.find((row) => row.inclusion === "private");
  const privateCo = bundle.contentObjects.find((row) => row.digest === privateEv?.digest);
  expect(privateEv && privateCo).toBeTruthy();
  const oldDigest = privateEv!.digest;
  privateEv!.inclusion = "present";
  privateEv!.digest = digest;
  privateEv!.byteLength = bytes.byteLength;
  privateCo!.inclusion = "present";
  privateCo!.digest = digest;
  privateCo!.byteLength = bytes.byteLength;
  privateCo!.payloadBase64 = bytes.toString("base64");
  for (const att of bundle.attachments) {
    if (att.digest === oldDigest) att.digest = digest;
  }
  return attachPortableIntegrity(unsignedOf(bundle));
}

describe("portable investigation archive contract", () => {
  it("is exported from the public package barrel", () => {
    expect(contractBarrel.PORTABLE_ARCHIVE_SCHEMA_ID).toBe(PORTABLE_ARCHIVE_SCHEMA_ID);
    expect(contractBarrel.parsePortableArchive).toBe(parsePortableArchive);
    expect(contractBarrel.preflightPortableArchive).toBe(preflightPortableArchive);
    expect(contractBarrel.sealPortableArchive).toBe(sealPortableArchive);
  });

  it("round-trips a sealed archive from the valid V1 fixture", () => {
    const investigation = valid();
    const sealed = sealPortableArchive({ investigation });
    expect(sealed.schemaId).toBe(PORTABLE_ARCHIVE_SCHEMA_ID);
    const parsed = parsePortableArchive(structuredClone(sealed));
    expect(parsed.semanticFingerprint).toBe(portableSemanticFingerprint(investigation));
    expect(parsed.transportHash).toBe(sealed.transportHash);
    expect(parsed.signature).toBeNull();
  });

  it("keeps semantic identity when export time and signature envelope change", () => {
    const investigation = valid();
    const first = sealPortableArchive({ investigation });
    const shiftedUnsigned = unsignedOf(investigation);
    shiftedUnsigned.exportedAt = "2026-08-24T21:00:00Z";
    const shifted = attachPortableIntegrity(shiftedUnsigned);
    const second = sealPortableArchive({
      investigation: shifted,
      exportedAt: shifted.exportedAt,
      signature: {
        signingKeyFingerprint: sha256Utf8("synth-signing-key-fingerprint-material"),
        hashInventory: shifted.objectHashes.map((row) => ({
          kind: row.kind,
          id: row.id,
          hash: row.hash,
        })),
        signatureBase64: Buffer.from("synth-ed25519-placeholder").toString("base64"),
      },
    });
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first.transportHash).not.toBe(second.transportHash);
    expect(parsePortableArchive(second).signature?.verificationStatus).toBe("unverified");
    expect(parsePortableArchive(second).signature?.authenticityClaim).toBe("none");
  });

  it("treats detached present blobs as digest-committed, not streaming or authenticated", () => {
    const investigation = valid();
    const detachedUnsigned = unsignedOf(structuredClone(investigation));
    const present = detachedUnsigned.contentObjects.find((row) => row.inclusion === "present");
    expect(present?.payloadBase64).toBeTruthy();
    present!.payloadBase64 = null;
    const detachedInvestigation = attachPortableIntegrity(detachedUnsigned);
    parsePortableInvestigation(detachedInvestigation, { requireInlinePresentPayload: false });
    const archive = sealPortableArchive({ investigation: detachedInvestigation });
    expect(archive.blobInventory.find((row) => row.digest === present!.digest)?.presence).toBe(
      "detached",
    );
    expect(archive.semanticFingerprint).toBe(portableSemanticFingerprint(investigation));
    expect(archive.transportHash).not.toBe(sealPortableArchive({ investigation }).transportHash);
    const blocked = preflightPortableArchive(archive, archiveDryRun(detachedInvestigation));
    expect(blocked.reconstructionStatus).toBe("blocked");
    expect(
      blocked.reconstructionReasons.some((row) => row.code === "declared_present_bytes_missing"),
    ).toBe(true);
    const restored = preflightPortableArchive(
      archive,
      archiveDryRun(detachedInvestigation, {
        suppliedBlobs: [
          {
            digest: present!.digest,
            byteLength: present!.byteLength,
            contentType: present!.contentType,
            presence: "inline",
            payloadBase64: investigation.contentObjects.find((row) => row.digest === present!.digest)!
              .payloadBase64,
          },
        ],
      }),
    );
    expect(restored.reconstructionStatus).toBe("metadata_only");
  });

  it("emits RFC 4122 UUID destination ids that are stable, namespaced, and collision-aware", () => {
    const investigation = valid();
    const archive = sealPortableArchive({ investigation });
    const first = preflightPortableArchive(archive, archiveDryRun(investigation));
    const reversed = preflightPortableArchive(
      archive,
      archiveDryRun(investigation, {
        identityMap: [...identityMapFor(investigation)].reverse(),
      }),
    );
    expect(first.idRemap.map((row) => `${row.namespace}:${row.sourceId}:${row.destinationId}`).sort()).toEqual(
      reversed.idRemap.map((row) => `${row.namespace}:${row.sourceId}:${row.destinationId}`).sort(),
    );
    expect(first.idRemap.length).toBeGreaterThan(10);
    for (const row of first.idRemap) {
      expect(isRfc4122Uuid(row.destinationId)).toBe(true);
      expect(row.destinationId).toMatch(RFC4122_UUID_RE);
      expect(row.sourceId).not.toBe(row.destinationId);
    }
    const evidence = first.idRemap.find((row) => row.namespace === "evidence");
    const contribution = first.idRemap.find((row) => row.namespace === "contribution");
    expect(evidence?.destinationId).not.toBe(contribution?.destinationId);
    const same = portableDestinationUuid(
      investigation.sourceInstallationId,
      "evidence",
      evidence!.sourceId,
      0,
    );
    expect(same).toBe(evidence!.destinationId);
    const otherInstall = portableDestinationUuid(
      "inst-otherlab0001",
      "evidence",
      evidence!.sourceId,
      0,
    );
    expect(otherInstall).not.toBe(evidence!.destinationId);
    const otherKind = portableDestinationUuid(
      investigation.sourceInstallationId,
      "contribution",
      evidence!.sourceId,
      0,
    );
    expect(otherKind).not.toBe(evidence!.destinationId);
    const collided = portableDestinationUuid(
      investigation.sourceInstallationId,
      "evidence",
      evidence!.sourceId,
      1,
    );
    expect(collided).not.toBe(evidence!.destinationId);
    const occupied = preflightPortableArchive(
      archive,
      archiveDryRun(investigation, {
        destination: {
          identities: [],
          objectIds: { evidence: [evidence!.destinationId] },
          knownProfileIds: ["profile-synth"],
        },
      }),
    );
    const remapped = occupied.idRemap.find((row) => row.namespace === "evidence" && row.sourceId === evidence!.sourceId);
    expect(remapped?.destinationId).toBe(collided);
  });

  it("returns exact reconstruction only when every required blob is present and matched", () => {
    const investigation = allPresentBundle();
    const archive = sealPortableArchive({ investigation });
    const report = preflightPortableArchive(archive, archiveDryRun(investigation));
    expect(report.schemaId).toBe(PORTABLE_ARCHIVE_PREFLIGHT_SCHEMA_ID);
    expect(report.reconstructionStatus).toBe("exact");
    expect(report.exactReconstruction).toBe(true);
    expect(report.applyAuthorized).toBe(false);
    expect(historicalRolesAreAttributionOnly(report)).toBe(true);
  });

  it("does not treat historical participant roles as destination grants", () => {
    const investigation = valid();
    expect(investigation.participants.some((row) => row.role.length > 0)).toBe(true);
    const report = preflightPortableArchive(
      sealPortableArchive({ investigation }),
      archiveDryRun(investigation),
    );
    expect(report.historicalParticipantsAreAttributionOnly).toBe(true);
    expect(report.destinationMembershipGranted).toBe(false);
    expect(report.destinationRoleGranted).toBe(false);
    expect(report.destinationCapabilityGranted).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/capability grant/i);
  });

  it("rejects signature metadata tampering and unknown fields without claiming verification", () => {
    const investigation = valid();
    const sealed = sealPortableArchive({
      investigation,
      signature: {
        signingKeyFingerprint: sha256Utf8("synth-signing-key-fingerprint-material"),
        hashInventory: [{ kind: "investigation", id: investigation.investigation.id, hash: investigation.investigation.objectHash }],
        signatureBase64: Buffer.from("synth-ed25519-placeholder").toString("base64"),
      },
    });
    const parsed = parsePortableArchive(sealed);
    expect(parsed.signature?.algorithm).toBe("Ed25519");
    expect(parsed.signature?.verificationStatus).toBe("unverified");
    const unknownField = structuredClone(sealed) as { signature: { extraClaim?: boolean } | null };
    unknownField.signature!.extraClaim = true;
    expect(() => parsePortableArchive(unknownField)).toThrow(/unknown key/);
    const verified = structuredClone(sealed);
    (verified.signature as { verificationStatus: string }).verificationStatus = "verified";
    expect(() => parsePortableArchive(verified)).toThrow(ContractViolation);
    const algo = structuredClone(sealed);
    (algo.signature as { algorithm: string }).algorithm = "SHA-256";
    expect(() => parsePortableArchive(algo)).toThrow(ContractViolation);
  });

  it("accepts the archive schema for a sealed valid fixture and rejects unknown fields", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "investigation-portable-archive.v1.json"), "utf8")) as object,
    );
    const sealed = sealPortableArchive({ investigation: valid() });
    expect(validate(sealed)).toBe(true);
    expect(validate(load("investigation-portable-archive.invalid.json"))).toBe(false);
  });

  it("parses the checked-in archive fixture as a versioned boundary compatible with V1", () => {
    const fixture = load("investigation-portable-archive.valid.json");
    const parsed = parsePortableArchive(fixture);
    expect(parsed.schemaId).toBe(PORTABLE_ARCHIVE_SCHEMA_ID);
    expect(parsed.semanticFingerprint).toBe(portableSemanticFingerprint(parsed.investigation));
    parsePortableInvestigation(parsed.investigation);
  });

  it("blocks declared-present digest and length mismatches from supplied blobs", () => {
    const investigation = valid();
    const detachedUnsigned = unsignedOf(structuredClone(investigation));
    const present = detachedUnsigned.contentObjects.find((row) => row.inclusion === "present")!;
    const originalPayload = present.payloadBase64;
    present.payloadBase64 = null;
    const detachedInvestigation = attachPortableIntegrity(detachedUnsigned);
    const archive = sealPortableArchive({ investigation: detachedInvestigation });
    const digestMismatch = preflightPortableArchive(
      archive,
      archiveDryRun(detachedInvestigation, {
        suppliedBlobs: [
          {
            digest: present.digest,
            byteLength: present.byteLength,
            contentType: present.contentType,
            presence: "inline",
            payloadBase64: Buffer.from("wrong-bytes").toString("base64"),
          },
        ],
      }),
    );
    expect(digestMismatch.reconstructionStatus).toBe("blocked");
    expect(
      digestMismatch.reconstructionReasons.some((row) => row.code === "declared_present_digest_mismatch"),
    ).toBe(true);
    expect(
      digestMismatch.reconstructionReasons.some((row) => row.code === "declared_present_length_mismatch"),
    ).toBe(true);
    expect(originalPayload).toBeTruthy();
  });

  it("rejects a tampered signedManifestHash without claiming verification", () => {
    const investigation = valid();
    const sealed = sealPortableArchive({
      investigation,
      signature: {
        signingKeyFingerprint: sha256Utf8("synth-signing-key-fingerprint-material"),
        hashInventory: investigation.objectHashes.map((row) => ({
          kind: row.kind,
          id: row.id,
          hash: row.hash,
        })),
        signatureBase64: Buffer.from("synth-ed25519-placeholder").toString("base64"),
      },
    });
    const tampered = structuredClone(sealed);
    tampered.signature!.signedManifestHash = "ab".repeat(32);
    expect(() => parsePortableArchive(tampered)).toThrow(ContractViolation);
  });

  it("changes transport hash when committed blob digest and bytes change", () => {
    const first = sealPortableArchive({ investigation: valid() });
    const mutated = unsignedOf(valid());
    const present = mutated.contentObjects.find((row) => row.inclusion === "present")!;
    const bytes = Buffer.from("synth-public-bytes-v2", "utf8");
    present.payloadBase64 = bytes.toString("base64");
    present.byteLength = bytes.byteLength;
    present.digest = createHash("sha256").update(bytes).digest("hex");
    const evidence = mutated.evidence.find((row) => row.inclusion === "present")!;
    evidence.digest = present.digest;
    evidence.byteLength = present.byteLength;
    for (const att of mutated.attachments) {
      if (att.digest === first.investigation.evidence.find((row) => row.inclusion === "present")!.digest) {
        att.digest = present.digest;
      }
    }
    const secondInv = attachPortableIntegrity(mutated);
    const second = sealPortableArchive({ investigation: secondInv });
    expect(second.transportHash).not.toBe(first.transportHash);
    expect(second.semanticFingerprint).not.toBe(first.semanticFingerprint);
  });

  it("blocks UUID remap collisions under fail with id_collision reconstruction", () => {
    const investigation = valid();
    const archive = sealPortableArchive({ investigation });
    const baseline = preflightPortableArchive(archive, archiveDryRun(investigation));
    const occupiedId = baseline.idRemap.find((row) => row.namespace === "investigation")!.destinationId;
    const failed = preflightPortableArchive(
      archive,
      archiveDryRun(investigation, {
        collisionPolicy: "fail",
        destination: {
          identities: [],
          objectIds: { investigation: [occupiedId] },
          knownProfileIds: ["profile-synth"],
        },
      }),
    );
    expect(failed.counts.conflict).toBeGreaterThan(0);
    expect(failed.reconstructionStatus).toBe("blocked");
    expect(failed.reconstructionReasons.some((row) => row.code === "id_collision")).toBe(true);
    expect(failed.applyAuthorized).toBe(false);
  });
});
