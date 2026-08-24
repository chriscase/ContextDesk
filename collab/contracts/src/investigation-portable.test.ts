import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { GOLD_ALIGNMENT_NOT_CORRECTNESS, GOLD_IS_HUMAN_BENCHMARK } from "./gold.js";
import * as contractBarrel from "./index.js";
import { ContractViolation } from "./parse.js";
import {
  PORTABLE_HISTORY_CAVEAT,
  PORTABLE_PERMISSION_CAVEAT,
  PORTABLE_PREFLIGHT_SCHEMA_ID,
  PORTABLE_PROTOCOL_VERSION,
  PORTABLE_SCHEMA_ID,
  attachPortableIntegrity,
  canonicalizePortableInvestigation,
  destinationCatalogDigest,
  parsePortableInvestigation,
  portableBundleFingerprint,
  portableSemanticFingerprint,
  portableSnapshotFingerprint,
  preflightPortableInvestigation,
  evaluatePortableReconstruction,
  isRfc4122Uuid,
  portableDestinationUuid,
  type PortableInvestigationUnsigned,
  type PortableInvestigationV1,
  type PreflightRequestV1,
} from "./investigation-portable.js";

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

function reseal(bundle: PortableInvestigationV1): PortableInvestigationV1 {
  return attachPortableIntegrity(unsignedOf(bundle));
}

function identityMapFor(bundle: PortableInvestigationV1): PreflightRequestV1["identityMap"] {
  return bundle.actors.map((actor) => ({
    sourceActorId: actor.sourceActorId,
    action: "leave_unresolved" as const,
    destinationActorId: null,
  }));
}

function dryRun(bundle: PortableInvestigationV1, overlay: Partial<PreflightRequestV1> = {}): PreflightRequestV1 {
  return {
    mode: "dry_run",
    collisionPolicy: "remap_deterministic",
    identityMap: identityMapFor(bundle),
    destination: { identities: [], objectIds: {}, knownProfileIds: ["profile-synth"] },
    ...overlay,
  };
}

describe("portable investigation contract", () => {
  it("is available through the public package barrel", () => {
    expect(contractBarrel.PORTABLE_SCHEMA_ID).toBe(PORTABLE_SCHEMA_ID);
    expect(contractBarrel.parsePortableInvestigation).toBe(parsePortableInvestigation);
    expect(contractBarrel.preflightPortableInvestigation).toBe(preflightPortableInvestigation);
  });

  it("accepts the valid fixture and rejects unknown fields via parse and Ajv", () => {
    const parsed = parsePortableInvestigation(load("investigation-portable.valid.json"));
    expect(parsed.schemaId).toBe(PORTABLE_SCHEMA_ID);
    expect(parsed.protocolVersion).toBe(PORTABLE_PROTOCOL_VERSION);
    expect(parsed.permissionCaveat).toBe(PORTABLE_PERMISSION_CAVEAT);
    expect(parsed.historyCaveat).toBe(PORTABLE_HISTORY_CAVEAT);
    expect(parsed.investigation.id).toBe("inv-1");
    expect(parsed.gold[0]?.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
    expect(parsed.alignments[0]?.notes).toContain(GOLD_ALIGNMENT_NOT_CORRECTNESS);
    expect(parsed.importedAiRuns[0]?.usageStatus).toBe("unknown");
    expect(parsed.importedAiRuns[0]?.costStatus).toBe("unknown");
    expect(parsed.triageJobs[0]?.candidates[0]?.usageStatus).toBe("unknown");
    expect(() => parsePortableInvestigation(load("investigation-portable.invalid.json"))).toThrow(
      /unknown key/,
    );
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "investigation-portable.v1.json"), "utf8")) as object,
    );
    expect(validate(load("investigation-portable.valid.json"))).toBe(true);
    expect(validate(load("investigation-portable.invalid.json"))).toBe(false);
  });

  it("round-trips parse and canonicalize deterministically", () => {
    const parsed = parsePortableInvestigation(load("investigation-portable.valid.json"));
    const canonical = canonicalizePortableInvestigation(parsed);
    expect(canonical.bundleFingerprint).toBe(parsed.bundleFingerprint);
    const again = canonicalizePortableInvestigation(parsePortableInvestigation(canonical));
    expect(JSON.stringify(again)).toBe(JSON.stringify(canonical));
    expect(portableBundleFingerprint(unsignedOf(parsed))).toBe(parsed.bundleFingerprint);
  });

  it("keeps canonical fingerprints stable across reordered bags", () => {
    const parsed = valid();
    const reordered = structuredClone(parsed);
    reordered.actors.reverse();
    reordered.contributions.reverse();
    reordered.evidence.reverse();
    reordered.contentObjects.reverse();
    reordered.snapshots.reverse();
    reordered.triageJobs[0]?.candidates.reverse();
    reordered.helpfulnessObservations.reverse();
    const sealed = attachPortableIntegrity(unsignedOf(reordered));
    expect(sealed.bundleFingerprint).toBe(parsed.bundleFingerprint);
    expect(JSON.stringify(canonicalizePortableInvestigation(sealed))).toBe(
      JSON.stringify(canonicalizePortableInvestigation(parsed)),
    );
  });

  it("reports typed reconstruction status instead of unconditional exactReconstruction", () => {
    const parsed = valid();
    const report = preflightPortableInvestigation(parsed, dryRun(parsed));
    expect(report.schemaId).toBe(PORTABLE_PREFLIGHT_SCHEMA_ID);
    expect(report.mode).toBe("dry_run");
    expect(report.reconstructionStatus).toBe("metadata_only");
    expect(report.exactReconstruction).toBe(false);
    expect(report.applyAuthorized).toBe(false);
    expect(report.destinationCatalogIsAuthorization).toBe(false);
    expect(report.historicalParticipantsAreAttributionOnly).toBe(true);
    expect(report.destinationMembershipGranted).toBe(false);
    expect(report.bundleFingerprint).toBe(parsed.bundleFingerprint);
    expect(report.semanticFingerprint).toBe(portableSemanticFingerprint(parsed));
    expect(report.counts.update).toBe(0);
    expect(report.idRemap.some((row) => row.namespace === "investigation")).toBe(true);
    expect(report.reconstructionReasons.some((row) => row.code === "content_private")).toBe(true);
  });

  it("does not auto-merge identity collisions across installations by name or email", () => {
    const parsed = valid();
    const alice = parsed.actors.find((row) => row.username === "alice");
    expect(alice).toBeTruthy();
    const request = dryRun(parsed, {
      destination: {
        identities: [
          {
            actorId: "dest-alice",
            username: "alice",
            email: alice?.email ?? "alice@destination.example",
            displayName: alice?.displayName ?? "Alice",
          },
        ],
        objectIds: {},
        knownProfileIds: ["profile-synth"],
      },
    });
    const report = preflightPortableInvestigation(parsed, request);
    const resolution = report.identityResolutions.find((row) => row.sourceActorId === alice?.sourceActorId);
    expect(resolution?.action).toBe("leave_unresolved");
    expect(resolution?.destinationActorId).toBeNull();
    expect(report.warnings.some((row) => row.code === "identity_name_collision")).toBe(true);
  });

  it("remaps the same raw ids in different namespaces independently", () => {
    const parsed = valid();
    parsed.contributions[0]!.id = "shared-raw";
    parsed.timeline[0]!.targetId = "shared-raw";
    parsed.discussions[0]!.messageIds = ["shared-raw"];
    const shareEv = parsed.evidence.find((row) => row.inclusion === "present")!;
    shareEv.id = "shared-raw";
    parsed.snapshots[0]!.evidence[0]!.evidenceId = "shared-raw";
    parsed.triageJobs[0]!.candidates[0]!.evidenceRefs = ["shared-raw"];
    parsed.helpfulnessObservations[0]!.evidenceRefs = ["shared-raw"];
    parsed.decisions[0]!.evidenceRefs = ["shared-raw"];
    parsed.gold[0]!.evidenceAnchors = ["shared-raw"];
    parsed.attachments[0]!.evidenceId = "shared-raw";
    const rebound = parsed.evidence.find((row) => row.id === "shared-raw")!;
    parsed.snapshots[0]!.evidence[0]!.privacyClass = rebound.privacyClass;
    parsed.snapshots[0]!.evidence[0]!.contentHash = rebound.digest;
    parsed.snapshots[0]!.fingerprint = portableSnapshotFingerprint(parsed.snapshots[0]!);
    parsed.triageJobs[0]!.snapshotFingerprint = parsed.snapshots[0]!.fingerprint;
    parsed.experiments[0]!.snapshotFingerprint = parsed.snapshots[0]!.fingerprint;
    const sealed = reseal(parsed);
    const report = preflightPortableInvestigation(sealed, dryRun(sealed));
    const contrib = report.idRemap.find((row) => row.namespace === "contribution" && row.sourceId === "shared-raw");
    const evidence = report.idRemap.find((row) => row.namespace === "evidence" && row.sourceId === "shared-raw");
    expect(contrib).toBeTruthy();
    expect(evidence).toBeTruthy();
    expect(contrib?.destinationId).not.toBe(evidence?.destinationId);
    expect(isRfc4122Uuid(contrib!.destinationId)).toBe(true);
    expect(isRfc4122Uuid(evidence!.destinationId)).toBe(true);
    expect(contrib?.destinationId).not.toContain("::");
    expect(evidence?.destinationId).not.toMatch(/^remap-/);
    expect(contrib?.destinationId).toBe(
      portableDestinationUuid(sealed.sourceInstallationId, "contribution", "shared-raw", 0),
    );
    expect(evidence?.destinationId).toBe(
      portableDestinationUuid(sealed.sourceInstallationId, "evidence", "shared-raw", 0),
    );
  });

  it("warns on missing profiles and fail-closes missing mapped users", () => {
    const parsed = valid();
    const report = preflightPortableInvestigation(
      parsed,
      dryRun(parsed, { destination: { identities: [], objectIds: {}, knownProfileIds: [] } }),
    );
    expect(report.warnings.some((row) => row.code === "missing_profile")).toBe(true);
    expect(report.warnings.some((row) => row.code === "missing_content")).toBe(true);

    const mapped: PreflightRequestV1 = dryRun(parsed, {
      identityMap: parsed.actors.map((actor, index) =>
        index === 0
          ? {
              sourceActorId: actor.sourceActorId,
              action: "map_existing" as const,
              destinationActorId: "nobody-at-destination",
            }
          : {
              sourceActorId: actor.sourceActorId,
              action: "leave_unresolved" as const,
              destinationActorId: null,
            },
      ),
    });
    const missing = preflightPortableInvestigation(parsed, mapped);
    expect(missing.referentialIntegrityFailures.some((row) => row.code === "missing_user")).toBe(
      true,
    );
    expect(missing.counts.blocked).toBeGreaterThan(0);
  });

  it("keeps owner-only omissions explicit and rejects illegal privacy claims", () => {
    const parsed = valid();
    const privateEv = parsed.evidence.find((row) => row.privacyClass === "owner_only");
    expect(privateEv?.inclusion).toBe("private");
    const privateContent = parsed.contentObjects.find((row) => row.digest === privateEv?.digest);
    expect(privateContent?.payloadBase64).toBeNull();
    const shareSnap = structuredClone(parsed);
    shareSnap.snapshots[0]!.evidence.push({
      evidenceId: privateEv!.id,
      ordinal: 1,
      contentHash: privateEv!.digest,
      privacyClass: "owner_only",
    });
    expect(() => reseal(shareSnap)).not.toThrow();
    expect(() => parsePortableInvestigation(reseal(shareSnap))).toThrow(/illegal privacy claim/);
  });

  it("fail-closes unknown fields, duplicate ids, and the tamper matrix", () => {
    const parsed = valid();
    expect(() => parsePortableInvestigation({ ...parsed, extra: true })).toThrow(/unknown key/);
    const dup = structuredClone(parsed);
    dup.actors.push({ ...dup.actors[0]! });
    expect(() => parsePortableInvestigation(dup)).toThrow(/duplicate id/);

    const rows: Array<[string, (row: PortableInvestigationV1) => void]> = [
      ["bundle fingerprint", (row) => {
        row.bundleFingerprint = "a".repeat(64);
      }],
      ["object hash list", (row) => {
        row.objectHashes[0]!.hash = "b".repeat(64);
      }],
      ["per-object hash", (row) => {
        row.investigation.objectHash = "c".repeat(64);
      }],
      ["content digest", (row) => {
        row.contentObjects[0]!.digest = "d".repeat(64);
      }],
      ["schema id", (row) => {
        (row as { schemaId: string }).schemaId = "cd-collab.investigation_portable.v0";
      }],
      ["invented usage", (row) => {
        (row.importedAiRuns[0] as { usageStatus: string }).usageStatus = "tokens_123";
      }],
    ];
    for (const [name, mutate] of rows) {
      const clone = structuredClone(parsed);
      mutate(clone);
      expect(() => parsePortableInvestigation(clone), name).toThrow(ContractViolation);
    }
  });

  it("fail-closes missing required content payloads", () => {
    const parsed = valid();
    const present = parsed.contentObjects.find((row) => row.inclusion === "present");
    expect(present).toBeTruthy();
    present!.payloadBase64 = null;
    expect(() => parsePortableInvestigation(reseal(parsed))).toThrow(/missing required content/);
  });

  it("fail-closes dangling references, cyclic lineage, and corrupt version chains", () => {
    const dangling = valid();
    dangling.snapshots[0]!.evidence[0]!.evidenceId = "missing-evidence";
    expect(() => parsePortableInvestigation(reseal(dangling))).toThrow(/dangling/);

    const cyclic = valid();
    cyclic.snapshots[0]!.parentSnapshotId = cyclic.snapshots[0]!.id;
    cyclic.snapshots[0]!.lineageClass = "derived";
    expect(() => parsePortableInvestigation(reseal(cyclic))).toThrow(/self\/cyclic lineage/);

    const chain = valid();
    chain.contributions[0]!.revision = 2;
    chain.contributions[0]!.predecessorRevision = 1;
    expect(() => parsePortableInvestigation(reseal(chain))).toThrow(/corrupt version chain/);
  });

  it("fail-closes a gold v>1 predecessorGoldId that is not any goldId in the bundle", () => {
    const parsed = valid();
    const v1 = parsed.gold[0]!;
    parsed.gold.push({
      ...v1,
      version: 2,
      predecessorGoldId: "ghost-gold-not-in-bundle",
      objectHash: "0".repeat(64),
    });
    expect(() => parsePortableInvestigation(reseal(parsed))).toThrow(/dangling gold predecessor/);
  });

  it("fail-closes dangling decision evidence refs", () => {
    const parsed = valid();
    parsed.decisions[0]!.evidenceRefs = ["missing"];
    expect(() => parsePortableInvestigation(reseal(parsed))).toThrow(/dangling evidence reference/);
  });

  it("stringify scan of the valid bundle has no credential, token, endpoint, LDAP, or secret leakage", () => {
    const raw = load("investigation-portable.valid.json");
    parsePortableInvestigation(raw);
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/ldap/i);
    expect(text).not.toMatch(/bearer\s+\S+/i);
    expect(text).not.toMatch(/sk-[a-z0-9_-]{8,}/i);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    for (const key of [
      "token",
      "secret",
      "password",
      "apiKey",
      "api_key",
      "endpoint",
      "baseUrl",
      "ldap",
      "bindDn",
      "gatewaySecret",
    ]) {
      expect(text.includes(`"${key}"`)).toBe(false);
    }
  });

  it("requires dry-run before apply and treats identity-map gaps as ambiguity", () => {
    const parsed = valid();
    expect(() =>
      preflightPortableInvestigation(parsed, { ...dryRun(parsed), mode: "apply" } as never),
    ).toThrow(/dry-run is required before apply/);
    expect(() =>
      preflightPortableInvestigation(parsed, { ...dryRun(parsed), identityMap: [] }),
    ).toThrow(/identity-map ambiguity/);
  });

  it("preserves canonical opaque payloads and rejects credential-bearing opaque JSON", () => {
    const parsed = valid();
    expect(parsed.importedAiRuns[0]?.opaquePayloadJson).toBe(
      '{"extraVendor":1,"vendorNote":"synthetic"}',
    );
    const leak = structuredClone(parsed);
    leak.importedAiRuns[0]!.opaquePayloadJson = '{"token":"sk-not-a-real-key"}';
    expect(() => parsePortableInvestigation(reseal(leak))).toThrow(
      /forbidden credential|credential, token, secret, or live endpoint leakage/,
    );
  });

  it("keeps semantic identity stable across exportedAt while transport fingerprint changes", () => {
    const first = valid();
    const shifted = unsignedOf(first);
    shifted.exportedAt = "2026-08-24T18:00:00Z";
    const second = attachPortableIntegrity(shifted);
    expect(portableSemanticFingerprint(first)).toBe(portableSemanticFingerprint(second));
    expect(first.bundleFingerprint).not.toBe(second.bundleFingerprint);
    expect(parsePortableInvestigation(first).bundleFingerprint).toBe(first.bundleFingerprint);
  });

  it("ignores inline payload bytes when computing semantic identity", () => {
    const first = valid();
    const stripped = unsignedOf(structuredClone(first));
    const present = stripped.contentObjects.find((row) => row.inclusion === "present");
    expect(present?.payloadBase64).toBeTruthy();
    present!.payloadBase64 = null;
    expect(portableSemanticFingerprint(stripped)).toBe(portableSemanticFingerprint(first));
    expect(() => parsePortableInvestigation(attachPortableIntegrity(stripped))).toThrow(
      /missing required content/,
    );
    expect(() =>
      parsePortableInvestigation(attachPortableIntegrity(stripped), {
        requireInlinePresentPayload: false,
      }),
    ).not.toThrow();
  });

  it("binds a host-authored catalog digest that is order-independent and not authorization", () => {
    const parsed = valid();
    const destinationA = {
      identities: [
        { actorId: "dest-b", username: "bravo", email: null, displayName: "Bravo" },
        { actorId: "dest-a", username: "alpha", email: "alpha@synthetic.example", displayName: "Alpha" },
      ],
      objectIds: { evidence: ["z-id", "a-id"], contribution: ["c-2", "c-1"] },
      knownProfileIds: ["profile-z", "profile-a"],
    };
    const destinationB = {
      identities: [...destinationA.identities].reverse(),
      objectIds: {
        contribution: ["c-1", "c-2"],
        evidence: ["a-id", "z-id"],
      },
      knownProfileIds: ["profile-a", "profile-z"],
    };
    expect(destinationCatalogDigest(destinationA)).toBe(destinationCatalogDigest(destinationB));
    const report = preflightPortableInvestigation(
      parsed,
      dryRun(parsed, { destination: destinationA }),
    );
    expect(report.destinationCatalogDigest).toBe(destinationCatalogDigest(destinationA));
    expect(report.destinationCatalogIsAuthorization).toBe(false);
    expect(report.destinationCatalogMustRevalidate).toBe(true);
  });

  it("marks reconstruction blocked when a mapped destination user is missing", () => {
    const parsed = valid();
    const mapped = dryRun(parsed, {
      identityMap: parsed.actors.map((actor, index) =>
        index === 0
          ? {
              sourceActorId: actor.sourceActorId,
              action: "map_existing" as const,
              destinationActorId: "nobody-at-destination",
            }
          : {
              sourceActorId: actor.sourceActorId,
              action: "leave_unresolved" as const,
              destinationActorId: null,
            },
      ),
    });
    const report = preflightPortableInvestigation(parsed, mapped);
    expect(report.reconstructionStatus).toBe("blocked");
    expect(report.exactReconstruction).toBe(false);
    expect(report.reconstructionReasons.some((row) => row.code === "missing_user")).toBe(true);
    expect(report.historicalParticipantsAreAttributionOnly).toBe(true);
    expect(report.destinationRoleGranted).toBe(false);
  });

  it("parent-fail: gold fixture is metadata_only rather than unconditional exactReconstruction true", () => {
    const parsed = valid();
    const report = preflightPortableInvestigation(parsed, dryRun(parsed));
    expect(report.reconstructionStatus).toBe("metadata_only");
    expect(report.exactReconstruction).toBe(false);
    expect(report.applyAuthorized).toBe(false);
  });

  it("returns exact reconstruction when every blob is present and matched", () => {
    const bundle = valid();
    const bytes = Buffer.from("synth-owner-notes-v1", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const privateEv = bundle.evidence.find((row) => row.inclusion === "private")!;
    const privateCo = bundle.contentObjects.find((row) => row.digest === privateEv.digest)!;
    const oldDigest = privateEv.digest;
    privateEv.inclusion = "present";
    privateEv.digest = digest;
    privateEv.byteLength = bytes.byteLength;
    privateCo.inclusion = "present";
    privateCo.digest = digest;
    privateCo.byteLength = bytes.byteLength;
    privateCo.payloadBase64 = bytes.toString("base64");
    for (const att of bundle.attachments) {
      if (att.digest === oldDigest) att.digest = digest;
    }
    const sealed = reseal(bundle);
    const report = preflightPortableInvestigation(sealed, dryRun(sealed));
    expect(report.reconstructionStatus).toBe("exact");
    expect(report.exactReconstruction).toBe(true);
    expect(report.applyAuthorized).toBe(false);
  });

  it("yields metadata_only for omitted and redacted content", () => {
    const omitted = valid();
    const presentEv = omitted.evidence.find((row) => row.inclusion === "present")!;
    const presentCo = omitted.contentObjects.find((row) => row.digest === presentEv.digest)!;
    presentEv.inclusion = "omitted";
    presentCo.inclusion = "omitted";
    presentCo.payloadBase64 = null;
    const omittedSealed = reseal(omitted);
    const omittedReport = preflightPortableInvestigation(omittedSealed, dryRun(omittedSealed));
    expect(omittedReport.reconstructionStatus).toBe("metadata_only");
    expect(omittedReport.reconstructionReasons.some((row) => row.code === "content_omitted")).toBe(true);

    const redacted = valid();
    const ev = redacted.evidence.find((row) => row.inclusion === "present")!;
    const co = redacted.contentObjects.find((row) => row.digest === ev.digest)!;
    ev.inclusion = "redacted";
    co.inclusion = "redacted";
    co.payloadBase64 = null;
    const redactedSealed = reseal(redacted);
    const redactedReport = preflightPortableInvestigation(redactedSealed, dryRun(redactedSealed));
    expect(redactedReport.reconstructionStatus).toBe("metadata_only");
    expect(redactedReport.reconstructionReasons.some((row) => row.code === "content_redacted")).toBe(true);
  });

  it("covers every reconstruction reason code via shipped evaluatePortableReconstruction", () => {
    const omitted = evaluatePortableReconstruction({
      evidence: [{ id: "e-omit", inclusion: "omitted" }],
      contentObjects: [],
      referentialIntegrityFailures: [],
    });
    expect(omitted.reconstructionStatus).toBe("metadata_only");
    expect(omitted.reconstructionReasons.map((row) => row.code)).toContain("content_omitted");

    const priv = evaluatePortableReconstruction({
      evidence: [{ id: "e-priv", inclusion: "private" }],
      contentObjects: [{ digest: "aa", inclusion: "private" }],
      referentialIntegrityFailures: [],
    });
    expect(priv.reconstructionReasons.some((row) => row.code === "content_private")).toBe(true);

    const redacted = evaluatePortableReconstruction({
      evidence: [{ id: "e-red", inclusion: "redacted" }],
      contentObjects: [],
      referentialIntegrityFailures: [],
    });
    expect(redacted.reconstructionReasons.some((row) => row.code === "content_redacted")).toBe(true);

    const missing = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [],
      referentialIntegrityFailures: [{ code: "missing_user", path: "actor:x", detail: "missing" }],
    });
    expect(missing.reconstructionStatus).toBe("blocked");
    expect(missing.reconstructionReasons.some((row) => row.code === "missing_user")).toBe(true);

    const collision = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [],
      referentialIntegrityFailures: [{ code: "id_collision", path: "evidence:e", detail: "collision" }],
    });
    expect(collision.reconstructionStatus).toBe("blocked");
    expect(collision.reconstructionReasons.some((row) => row.code === "id_collision")).toBe(true);

    const blocking = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [],
      referentialIntegrityFailures: [{ code: "identity_name_collision", path: "actor:y", detail: "synthetic" }],
    });
    expect(blocking.reconstructionStatus).toBe("blocked");
    expect(blocking.reconstructionReasons.some((row) => row.code === "blocking_identity_action")).toBe(true);

    const missingBytes = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [{ digest: "aa", inclusion: "present", payloadBase64: null, byteLength: 4 }],
      referentialIntegrityFailures: [],
    });
    expect(missingBytes.reconstructionStatus).toBe("blocked");
    expect(missingBytes.reconstructionReasons.some((row) => row.code === "declared_present_bytes_missing")).toBe(true);

    const four = Buffer.from("nope").toString("base64");
    const digestMismatch = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [{ digest: "ab".repeat(32), inclusion: "present", payloadBase64: four, byteLength: 4 }],
      referentialIntegrityFailures: [],
    });
    expect(digestMismatch.reconstructionReasons.some((row) => row.code === "declared_present_digest_mismatch")).toBe(true);

    const lengthMismatch = evaluatePortableReconstruction({
      evidence: [],
      contentObjects: [{ digest: "ab".repeat(32), inclusion: "present", payloadBase64: four, byteLength: 99 }],
      referentialIntegrityFailures: [],
    });
    expect(lengthMismatch.reconstructionReasons.some((row) => row.code === "declared_present_length_mismatch")).toBe(true);
  });
});
