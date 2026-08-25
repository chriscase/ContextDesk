/**
 * Exact-head regressions for the six apply-readiness audit blockers.
 *
 * Each case targets parsePortableInvestigation / preflightPortableInvestigation
 * so it can be copied onto parent #1032 (9f8eef13) and shown to fail there,
 * then pass here. Fixtures are fully synthetic.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portable from "./investigation-portable.js";
import type {
  PortableInvestigationUnsigned,
  PortableInvestigationV1,
  PreflightRequestV1,
} from "./investigation-portable.js";

const RFC4122_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const here = dirname(fileURLToPath(import.meta.url));

function loadValid(): PortableInvestigationV1 {
  return structuredClone(
    JSON.parse(
      readFileSync(join(here, "..", "fixtures", "investigation-portable.valid.json"), "utf8"),
    ),
  ) as PortableInvestigationV1;
}

function unsignedOf(bundle: PortableInvestigationV1): PortableInvestigationUnsigned {
  const { bundleFingerprint: _fp, objectHashes: _hashes, ...rest } = bundle;
  return rest;
}

function reseal(bundle: PortableInvestigationV1): PortableInvestigationV1 {
  return portable.attachPortableIntegrity(unsignedOf(bundle));
}

function identityMapFor(bundle: PortableInvestigationV1): PreflightRequestV1["identityMap"] {
  return bundle.actors.map((actor) => ({
    sourceActorId: actor.sourceActorId,
    action: "leave_unresolved" as const,
    destinationActorId: null,
  }));
}

function dryRun(
  bundle: PortableInvestigationV1,
  overlay: Partial<PreflightRequestV1> = {},
): PreflightRequestV1 {
  return {
    mode: "dry_run",
    collisionPolicy: "remap_deterministic",
    identityMap: identityMapFor(bundle),
    destination: { identities: [], objectIds: {}, knownProfileIds: ["profile-synth"] },
    ...overlay,
  };
}

describe("audit blockers vs parent #1032", () => {
  it("blocker 1: withheld evidence must not reference present payload bytes", () => {
    const bundle = loadValid();
    const share = bundle.evidence.find((row) => row.id === "ev-share");
    expect(share).toBeTruthy();
    share!.inclusion = "omitted";
    const content = bundle.contentObjects.find((row) => row.digest === share!.digest);
    expect(content?.inclusion).toBe("present");
    expect(content?.payloadBase64).toBeTruthy();
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /dishonest withholding metadata/,
    );
  });

  it("blocker 1: withheld attachments must not reference present payload bytes", () => {
    const bundle = loadValid();
    bundle.attachments[0]!.inclusion = "redacted";
    const content = bundle.contentObjects.find(
      (row) => row.digest === bundle.attachments[0]!.digest,
    );
    expect(content?.inclusion).toBe("present");
    expect(content?.payloadBase64).toBeTruthy();
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /dishonest withholding metadata/,
    );
  });

  it("blocker 1: private evidence cannot borrow a present content object", () => {
    const bundle = loadValid();
    const share = bundle.evidence.find((row) => row.id === "ev-share")!;
    const priv = bundle.evidence.find((row) => row.id === "ev-private")!;
    priv.digest = share.digest;
    priv.byteLength = share.byteLength;
    priv.inclusion = "private";
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /dishonest withholding metadata/,
    );
  });

  it("blocker 2: snapshot contentHash must match exported evidence before same_snapshot", () => {
    const bundle = loadValid();
    const snap = bundle.snapshots[0]!;
    snap.evidence[0]!.contentHash = "aa".repeat(32);
    snap.fairnessClass = "same_snapshot";
    snap.fingerprint = portable.portableSnapshotFingerprint(snap);
    bundle.triageJobs[0]!.snapshotFingerprint = snap.fingerprint;
    bundle.experiments[0]!.snapshotFingerprint = snap.fingerprint;
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /snapshot contentHash does not match exported evidence/,
    );
  });

  it("blocker 2: snapshot privacyClass must match exported evidence before same_snapshot", () => {
    const bundle = loadValid();
    const snap = bundle.snapshots[0]!;
    snap.visibility = "owner_only";
    snap.evidence[0]!.privacyClass = "owner_only";
    snap.fairnessClass = "same_snapshot";
    snap.fingerprint = portable.portableSnapshotFingerprint(snap);
    bundle.triageJobs[0]!.snapshotFingerprint = snap.fingerprint;
    bundle.experiments[0]!.snapshotFingerprint = snap.fingerprint;
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /snapshot privacyClass does not match exported evidence/,
    );
  });

  it("blocker 3: experiment candidateIds must be backed by a triage job or imported run", () => {
    const bundle = loadValid();
    bundle.experiments[0]!.candidateIds.push("cand-ghost");
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /experiment candidate is not backed by a triage job or imported AI run/,
    );
  });

  it("blocker 3: an imported AI run can remain a first-class experiment candidate", () => {
    const bundle = loadValid();
    const imported = bundle.importedAiRuns[0];
    expect(imported).toBeTruthy();
    bundle.experiments[0]!.candidateIds.push(`chat-${imported!.id}`);
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).not.toThrow();
  });

  it("blocker 3: helpfulness candidateIds must belong to that experiment", () => {
    const bundle = loadValid();
    bundle.helpfulnessObservations[0]!.candidateId = "cand-outsider";
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /candidate does not belong to that experiment/,
    );
  });

  it("blocker 3: alignment candidateIds must belong to the gold experiment", () => {
    const bundle = loadValid();
    bundle.alignments[0]!.candidateId = "cand-outsider";
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /candidate does not belong to that experiment/,
    );
  });

  it("blocker 3: gold may reference only the accepted decision for the same experiment", () => {
    const bundle = loadValid();
    const exp2 = structuredClone(bundle.experiments[0]!);
    exp2.id = "exp-2";
    bundle.experiments.push(exp2);
    const dec2 = structuredClone(bundle.decisions[0]!);
    dec2.id = "dec-2";
    dec2.experimentId = "exp-2";
    bundle.decisions.push(dec2);
    bundle.gold[0]!.acceptedDecisionId = "dec-2";
    expect(bundle.gold[0]!.experimentId).toBe("exp-1");
    expect(() => portable.parsePortableInvestigation(reseal(bundle))).toThrow(
      /gold accepted decision must belong to the same experiment/,
    );
  });

  it("blocker 4: V1 dry-run keeps content digests and UUID-remaps minted namespaces", () => {
    const sealed = reseal(loadValid());
    const report = portable.preflightPortableInvestigation(sealed, dryRun(sealed));
    expect(report.idRemap.length).toBeGreaterThan(10);
    for (const row of report.idRemap) {
      if (row.namespace === "content") {
        expect(row.destinationId).toBe(row.sourceId);
        expect(row.destinationId).toMatch(/^[a-f0-9]{64}$/);
      } else {
        expect(row.destinationId).toMatch(RFC4122_UUID_RE);
      }
      expect(row.destinationId.includes("::")).toBe(false);
      expect(row.destinationId.startsWith("remap-")).toBe(false);
      expect(row.destinationId).not.toBe(
        `${sealed.sourceInstallationId}::${row.namespace}::${row.sourceId}`,
      );
    }
    const contrib = report.idRemap.find((row) => row.namespace === "contribution");
    const evidence = report.idRemap.find((row) => row.namespace === "evidence");
    expect(contrib?.destinationId).not.toBe(evidence?.destinationId);
  });

  it("blocker 4: UUID remaps are collision-safe and skip an occupied destination UUID", () => {
    expect(typeof portable.portableDestinationUuid).toBe("function");
    const sealed = reseal(loadValid());
    const evidence = sealed.evidence[1]!;
    const occupied = portable.portableDestinationUuid(
      sealed.sourceInstallationId,
      "evidence",
      evidence.id,
      0,
    );
    const fallback = portable.portableDestinationUuid(
      sealed.sourceInstallationId,
      "evidence",
      evidence.id,
      1,
    );
    expect(occupied).toMatch(RFC4122_UUID_RE);
    expect(fallback).toMatch(RFC4122_UUID_RE);
    expect(fallback).not.toBe(occupied);
    const report = portable.preflightPortableInvestigation(
      sealed,
      dryRun(sealed, {
        destination: {
          identities: [],
          objectIds: { evidence: [occupied] },
          knownProfileIds: ["profile-synth"],
        },
      }),
    );
    const remapped = report.idRemap.find(
      (row) => row.namespace === "evidence" && row.sourceId === evidence.id,
    );
    expect(remapped?.destinationId).toBe(fallback);
    expect(remapped?.destinationId.startsWith("remap-")).toBe(false);
  });

  it("blocker 5: semantic vs transport hash, reconstruction, catalog digest, and non-authoritative roles remain shipped", () => {
    expect(typeof portable.portableSemanticFingerprint).toBe("function");
    expect(typeof portable.portableBundleFingerprint).toBe("function");
    expect(typeof portable.evaluatePortableReconstruction).toBe("function");
    expect(typeof portable.destinationCatalogDigest).toBe("function");

    const sealed = reseal(loadValid());
    const later = structuredClone(sealed);
    later.exportedAt = "2026-08-24T00:00:00Z";
    const resealedLater = reseal(later);
    expect(portable.portableSemanticFingerprint(sealed)).toBe(
      portable.portableSemanticFingerprint(resealedLater),
    );
    expect(portable.portableBundleFingerprint(unsignedOf(sealed))).not.toBe(
      portable.portableBundleFingerprint(unsignedOf(resealedLater)),
    );

    const request = dryRun(sealed);
    const report = portable.preflightPortableInvestigation(sealed, request);
    expect(report.reconstructionStatus).toBe("metadata_only");
    expect(report.exactReconstruction).toBe(false);
    expect(report.applyAuthorized).toBe(false);
    expect(report.destinationCatalogIsAuthorization).toBe(false);
    expect(report.destinationCatalogMustRevalidate).toBe(true);
    expect(report.historicalParticipantsAreAttributionOnly).toBe(true);
    expect(report.destinationMembershipGranted).toBe(false);
    expect(report.destinationRoleGranted).toBe(false);
    expect(report.destinationCapabilityGranted).toBe(false);
    expect(report.destinationCatalogDigest).toBe(
      portable.destinationCatalogDigest(request.destination),
    );
  });

  it("blocker 5: archive blob inventory and typed Ed25519 metadata remain shipped", async () => {
    const archive = await import("./investigation-portable-archive.js");
    expect(archive.BLOB_PRESENCES).toEqual(
      expect.arrayContaining(["inline", "detached", "omitted", "private", "redacted"]),
    );
    expect(archive.ARCHIVE_SIGNATURE_ALGORITHMS).toEqual(["Ed25519"]);
    const sealed = reseal(loadValid());
    const packed = archive.sealPortableArchive({ investigation: sealed });
    expect(packed.blobInventory.length).toBeGreaterThan(0);
    if (packed.signature !== null) {
      expect(packed.signature.algorithm).toBe("Ed25519");
      expect(packed.signature.verificationStatus).toBe("unverified");
      expect(packed.signature.authenticityClaim).toBe("none");
    }
    const report = archive.preflightPortableArchive(packed, {
      mode: "dry_run",
      collisionPolicy: "remap_deterministic",
      identityMap: identityMapFor(sealed),
      destination: { identities: [], objectIds: {}, knownProfileIds: ["profile-synth"] },
    });
    for (const row of report.idRemap) {
      if (row.namespace === "content") {
        expect(row.destinationId).toBe(row.sourceId);
      } else {
        expect(row.destinationId).toMatch(RFC4122_UUID_RE);
      }
    }
    expect(report.applyAuthorized).toBe(false);
  });

  it("blocker 6: shipped portable fixtures stay fully synthetic", () => {
    const raw = readFileSync(
      join(here, "..", "fixtures", "investigation-portable.valid.json"),
      "utf8",
    );
    const text = raw.toLowerCase();
    expect(text).toContain("fixture");
    expect(text).not.toMatch(/ldap:\/\//);
    expect(text).not.toMatch(/bearer\s+\S+/);
    expect(text).not.toMatch(/sk-[a-z0-9_-]{8,}/);
    expect(text).not.toMatch(/akia[0-9a-z]{16}/);
    expect(JSON.stringify(JSON.parse(raw))).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    for (const key of ["token", "secret", "password", "apiKey", "api_key", "endpoint", "baseUrl"]) {
      expect(raw.includes(`"${key}"`)).toBe(false);
    }
  });
});
