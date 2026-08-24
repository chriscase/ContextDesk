import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GOLD_ALIGNMENT_NOT_CORRECTNESS, GOLD_IS_HUMAN_BENCHMARK } from "./gold.js";
import {
  PORTABLE_HISTORY_CAVEAT,
  PORTABLE_PERMISSION_CAVEAT,
  PORTABLE_PROTOCOL_VERSION,
  PORTABLE_SCHEMA_ID,
  attachPortableIntegrity,
  canonicalJson,
  canonicalizePortableInvestigation,
  computePortableObjectHashes,
  parsePortableInvestigation,
  portableBundleFingerprint,
  portableSnapshotFingerprint,
  preflightPortableInvestigation,
  type PortableInvestigationUnsigned,
  type PortableInvestigationV1,
  type PreflightRequestV1,
} from "./investigation-portable.js";

const Z = "0".repeat(64);
const TS = "2026-08-24T15:00:00Z";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unsignedSynthetic(): PortableInvestigationUnsigned {
  const publicBytes = "synth-public-excerpt-v1";
  const restrictedBytes = "synth-restricted-bytes";
  const noteBody = "North operator recorded a stalled worker in the synthetic lab.";
  const publicHash = sha(publicBytes);
  const restrictedHash = sha(restrictedBytes);
  const noteHash = sha(noteBody);
  const auditHash = sha("synth-audit-summary");
  const opaque = '{"extraVendor":1,"vendorNote":"synthetic"}';
  const snapEvidence = [
    {
      evidenceId: "ev-public-1",
      ordinal: 0,
      contentHash: publicHash,
      privacyClass: "share_safe" as const,
    },
  ];
  const snapFingerprint = portableSnapshotFingerprint({
    parentSnapshotId: null,
    evidence: snapEvidence,
    visibility: "share_safe",
    protocolVersion: "cd.v1",
  });
  const taskFingerprint = sha('{"task":"synth-compare"}');
  const requestFingerprint = sha('{"strategyId":"strat-synth-1","question":"Why did the worker stall?"}');
  return {
    schemaId: PORTABLE_SCHEMA_ID,
    protocolVersion: PORTABLE_PROTOCOL_VERSION,
    sourceInstallationId: "inst-synthlab0001",
    exportedAt: TS,
    permissionCaveat: PORTABLE_PERMISSION_CAVEAT,
    historyCaveat: PORTABLE_HISTORY_CAVEAT,
    investigation: {
      id: "inv-synth-alpha",
      title: "Synthetic stalled-worker investigation",
      status: "open",
      severity: "medium",
      legalHold: false,
      retentionClass: "standard",
      privacyClass: "share_safe",
      createdAt: TS,
      createdBy: "operator-north",
      objectHash: Z,
    },
    actors: [
      {
        sourceActorId: "operator-north",
        username: "northbound",
        displayName: "Northbound Operator",
        email: null,
        roleNote: "case-lead",
        objectHash: Z,
      },
      {
        sourceActorId: "reviewer-west",
        username: "westreview",
        displayName: "West Reviewer",
        email: null,
        roleNote: "contributor",
        objectHash: Z,
      },
    ],
    participants: [
      { sourceActorId: "operator-north", role: "case-lead" },
      { sourceActorId: "reviewer-west", role: "contributor" },
    ],
    contributions: [
      {
        id: "note-north-1",
        kind: "note",
        revision: 1,
        predecessorRevision: null,
        body: noteBody,
        contentHash: noteHash,
        privacyClass: "share_safe",
        tombstoned: false,
        authorId: "operator-north",
        sourceId: "src-operator",
        createdAt: TS,
        hypothesisStatus: null,
        objectHash: Z,
      },
    ],
    evidence: [
      {
        id: "ev-public-1",
        title: "Public worker excerpt",
        privacyClass: "share_safe",
        digest: publicHash,
        inclusion: "present",
        contentType: "text/plain",
        byteLength: Buffer.byteLength(publicBytes),
        createdBy: "operator-north",
        createdAt: TS,
        objectHash: Z,
      },
      {
        id: "ev-restricted-1",
        title: "Restricted operator notes",
        privacyClass: "owner_only",
        digest: restrictedHash,
        inclusion: "private",
        contentType: "text/plain",
        byteLength: Buffer.byteLength(restrictedBytes),
        createdBy: "operator-north",
        createdAt: TS,
        objectHash: Z,
      },
    ],
    contentObjects: [
      {
        digest: publicHash,
        byteLength: Buffer.byteLength(publicBytes),
        contentType: "text/plain",
        inclusion: "present",
        payloadBase64: Buffer.from(publicBytes).toString("base64"),
        objectHash: Z,
      },
      {
        digest: restrictedHash,
        byteLength: Buffer.byteLength(restrictedBytes),
        contentType: "text/plain",
        inclusion: "private",
        payloadBase64: null,
        objectHash: Z,
      },
    ],
    sources: [
      {
        id: "src-operator",
        name: "Operator notes",
        kind: "human",
        lifecycle: "active",
        identityId: "operator-north",
        createdAt: TS,
        createdBy: "operator-north",
        objectHash: Z,
      },
      {
        id: "src-imported-run",
        name: "Imported model run",
        kind: "external-tool",
        lifecycle: "active",
        identityId: null,
        createdAt: TS,
        createdBy: "operator-north",
        objectHash: Z,
      },
    ],
    importedAiRuns: [
      {
        id: "run-imported-1",
        sourceId: "src-imported-run",
        importedAt: TS,
        providerKind: "unknown",
        model: "synth-reasoner-a",
        version: "1",
        profileId: "profile-synth-a",
        usageStatus: "unknown",
        costStatus: "unknown",
        outputDigest: publicHash,
        opaquePayloadJson: opaque,
        objectHash: Z,
      },
    ],
    snapshots: [
      {
        id: "snap-frozen-1",
        fingerprint: snapFingerprint,
        parentSnapshotId: null,
        fairnessClass: "same_snapshot",
        lineageClass: "root",
        visibility: "share_safe",
        protocolVersion: "cd.v1",
        evidence: snapEvidence,
        createdAt: TS,
        createdBy: "operator-north",
        objectHash: Z,
      },
    ],
    triageJobs: [
      {
        id: "job-compare-1",
        snapshotId: "snap-frozen-1",
        snapshotFingerprint: snapFingerprint,
        strategyId: "strat-synth-1",
        status: "completed",
        parentJobId: null,
        requestFingerprint,
        candidates: [
          {
            candidateId: "cand-primary-1",
            role: "primary",
            providerKind: "unknown",
            profileId: "profile-synth-a",
            model: "synth-reasoner-a",
            version: "1",
            usageStatus: "unknown",
            costStatus: "unknown",
            outputHash: publicHash,
            evidenceRefs: ["ev-public-1"],
          },
        ],
        requestedBy: "operator-north",
        createdAt: TS,
        objectHash: Z,
      },
    ],
    experiments: [
      {
        id: "exp-compare-1",
        packageId: "pkg-synth-1",
        snapshotFingerprint: snapFingerprint,
        taskFingerprint,
        candidateIds: ["cand-primary-1"],
        createdAt: TS,
        objectHash: Z,
      },
    ],
    helpfulnessObservations: [
      {
        id: "help-obs-1",
        experimentId: "exp-compare-1",
        candidateId: "cand-primary-1",
        dimension: "evidence_support",
        score: 1,
        rationale: "Cites the public excerpt.",
        evidenceRefs: ["ev-public-1"],
        reviewerId: "reviewer-west",
        createdAt: TS,
        objectHash: Z,
      },
    ],
    decisions: [
      {
        id: "dec-accepted-1",
        experimentId: "exp-compare-1",
        status: "accepted",
        revision: 1,
        predecessorRevision: null,
        text: "Restart the stalled worker.",
        rationale: "Matches the recorded excerpt.",
        evidenceRefs: ["ev-public-1"],
        authorId: "operator-north",
        createdAt: TS,
        objectHash: Z,
      },
    ],
    gold: [
      {
        goldId: "gold-human-1",
        version: 1,
        predecessorGoldId: null,
        experimentId: "exp-compare-1",
        acceptedDecisionId: "dec-accepted-1",
        acceptedDecisionRevision: 1,
        evidenceAnchors: ["ev-public-1"],
        notes: [GOLD_IS_HUMAN_BENCHMARK],
        promotedById: "operator-north",
        createdAt: TS,
        objectHash: Z,
      },
    ],
    alignments: [
      {
        id: "align-1",
        goldId: "gold-human-1",
        candidateId: "cand-primary-1",
        status: "aligned",
        matchedAnchors: ["ev-public-1"],
        missingAnchors: [],
        extraAnchors: [],
        notes: [GOLD_ALIGNMENT_NOT_CORRECTNESS],
        objectHash: Z,
      },
    ],
    discussions: [
      {
        id: "disc-notes-1",
        title: "Operator notes",
        authorId: "operator-north",
        createdAt: TS,
        messageIds: ["note-north-1"],
        objectHash: Z,
      },
    ],
    timeline: [
      {
        seq: 1,
        kind: "contribution_created",
        actorId: "operator-north",
        targetId: "note-north-1",
        targetNamespace: "contribution",
        serverTime: TS,
        objectHash: Z,
      },
    ],
    auditRefs: [
      {
        id: "aud-export-1",
        kind: "export_prepared",
        actorId: "operator-north",
        createdAt: TS,
        summaryHash: auditHash,
        objectHash: Z,
      },
    ],
    attachments: [
      {
        id: "att-1",
        discussionId: "disc-notes-1",
        evidenceId: "ev-public-1",
        digest: publicHash,
        inclusion: "present",
        objectHash: Z,
      },
    ],
  };
}

function syntheticSeal(): PortableInvestigationV1 {
  return attachPortableIntegrity(unsignedSynthetic());
}

function reseal(bundle: PortableInvestigationV1): PortableInvestigationV1 {
  const { bundleFingerprint: _fp, objectHashes: _hashes, ...rest } = bundle;
  return attachPortableIntegrity(rest);
}

function dryRun(
  bundle: PortableInvestigationV1,
  overlay: Partial<PreflightRequestV1> = {},
): PreflightRequestV1 {
  return {
    mode: "dry_run",
    collisionPolicy: "remap_deterministic",
    identityMap: bundle.actors.map((actor) => ({
      sourceActorId: actor.sourceActorId,
      action: "leave_unresolved" as const,
      destinationActorId: null,
    })),
    destination: {
      identities: [],
      objectIds: {},
      knownProfileIds: ["profile-synth-a"],
    },
    ...overlay,
  };
}

function remapKey(row: { namespace: string; sourceId: string; destinationId: string }): string {
  return `${row.namespace}:${row.sourceId}->${row.destinationId}`;
}

function remapCandidate(
  installationId: string,
  namespace: string,
  sourceId: string,
  attempt: number,
): string {
  const input = attempt === 0
    ? `${installationId}:${namespace}:${sourceId}`
    : canonicalJson([installationId, namespace, sourceId, attempt]);
  return `remap-${sha(input).slice(0, 24)}`;
}

describe("portable investigation adversarial lab", () => {
  it("seals, parses, canonicalizes, fingerprints, hashes, and dry-runs a complete synthetic bundle", () => {
    const sealed = syntheticSeal();
    const parsed = parsePortableInvestigation(structuredClone(sealed));
    expect(parsed.schemaId).toBe(PORTABLE_SCHEMA_ID);
    expect(parsed.protocolVersion).toBe(PORTABLE_PROTOCOL_VERSION);
    expect(portableBundleFingerprint(sealed)).toBe(sealed.bundleFingerprint);
    expect(computePortableObjectHashes(sealed)).toEqual(sealed.objectHashes);
    const canonical = canonicalizePortableInvestigation(parsed);
    expect(canonical.bundleFingerprint).toBe(sealed.bundleFingerprint);
    const report = preflightPortableInvestigation(parsed, dryRun(parsed));
    expect(report.applyAuthorized).toBe(false);
    expect(report.exactReconstruction).toBe(false);
    expect(report.reconstructionStatus).toBe("metadata_only");
    expect(report.bundleFingerprint).toBe(sealed.bundleFingerprint);
    expect(report.counts.update).toBe(0);
  });

  it("does not mutate caller-owned parse or preflight inputs", () => {
    const sealed = syntheticSeal();
    const req = dryRun(sealed);
    const sealedSnap = structuredClone(sealed);
    const reqSnap = structuredClone(req);
    parsePortableInvestigation(sealed);
    preflightPortableInvestigation(sealed, req);
    expect(sealed).toEqual(sealedSnap);
    expect(req).toEqual(reqSnap);
  });

  it("rejects unknown fields at every major nesting level", () => {
    const nests: Array<[string, (row: PortableInvestigationV1) => Record<string, unknown>]> = [
      ["top", (row) => row as unknown as Record<string, unknown>],
      ["investigation", (row) => row.investigation as unknown as Record<string, unknown>],
      ["actor", (row) => row.actors[0] as unknown as Record<string, unknown>],
      ["participant", (row) => row.participants[0] as unknown as Record<string, unknown>],
      ["contribution", (row) => row.contributions[0] as unknown as Record<string, unknown>],
      ["evidence", (row) => row.evidence[0] as unknown as Record<string, unknown>],
      ["content", (row) => row.contentObjects[0] as unknown as Record<string, unknown>],
      ["source", (row) => row.sources[0] as unknown as Record<string, unknown>],
      ["imported run", (row) => row.importedAiRuns[0] as unknown as Record<string, unknown>],
      ["snapshot", (row) => row.snapshots[0] as unknown as Record<string, unknown>],
      ["snapshot evidence", (row) => row.snapshots[0]!.evidence[0] as unknown as Record<string, unknown>],
      ["triage job", (row) => row.triageJobs[0] as unknown as Record<string, unknown>],
      ["triage candidate", (row) => row.triageJobs[0]!.candidates[0] as unknown as Record<string, unknown>],
      ["experiment", (row) => row.experiments[0] as unknown as Record<string, unknown>],
      ["helpfulness", (row) => row.helpfulnessObservations[0] as unknown as Record<string, unknown>],
      ["decision", (row) => row.decisions[0] as unknown as Record<string, unknown>],
      ["gold", (row) => row.gold[0] as unknown as Record<string, unknown>],
      ["alignment", (row) => row.alignments[0] as unknown as Record<string, unknown>],
      ["discussion", (row) => row.discussions[0] as unknown as Record<string, unknown>],
      ["timeline", (row) => row.timeline[0] as unknown as Record<string, unknown>],
      ["audit", (row) => row.auditRefs[0] as unknown as Record<string, unknown>],
      ["attachment", (row) => row.attachments[0] as unknown as Record<string, unknown>],
      ["object hash entry", (row) => row.objectHashes[0] as unknown as Record<string, unknown>],
    ];
    for (const [name, pick] of nests) {
      const row = syntheticSeal();
      pick(row).unexpectedSyntheticField = true;
      expect(() => parsePortableInvestigation(row), name).toThrow(/unknown key/);
    }
  });

  it("rejects missing, duplicated, substituted, and cross-namespace object-hash entries", () => {
    const missing = syntheticSeal();
    missing.objectHashes = missing.objectHashes.slice(1);
    expect(() => parsePortableInvestigation(missing)).toThrow(/hash\/fingerprint mismatch/);

    const duplicated = syntheticSeal();
    duplicated.objectHashes = [...duplicated.objectHashes, duplicated.objectHashes[0]!];
    expect(() => parsePortableInvestigation(duplicated)).toThrow(/hash\/fingerprint mismatch/);

    const substituted = syntheticSeal();
    substituted.objectHashes[0] = { ...substituted.objectHashes[0]!, hash: "ab".repeat(32) };
    expect(() => parsePortableInvestigation(substituted)).toThrow(/hash\/fingerprint mismatch/);

    const crossed = syntheticSeal();
    const actorHash = crossed.objectHashes.find((row) => row.kind === "actor");
    const invHash = crossed.objectHashes.find((row) => row.kind === "investigation");
    expect(actorHash && invHash).toBeTruthy();
    crossed.objectHashes = crossed.objectHashes.map((row) =>
      row.kind === "investigation" ? { ...row, hash: actorHash!.hash } : row,
    );
    expect(() => parsePortableInvestigation(crossed)).toThrow(/hash\/fingerprint mismatch/);
  });

  it("accepts equivalent unordered bags and reordered object-hash entries with an identical canonical fingerprint", () => {
    const sealed = syntheticSeal();
    const reordered = structuredClone(sealed);
    reordered.actors.reverse();
    reordered.evidence.reverse();
    reordered.objectHashes.reverse();
    reordered.triageJobs[0]!.candidates.reverse();
    const resealed = reseal(reordered);
    expect(resealed.bundleFingerprint).toBe(sealed.bundleFingerprint);
    expect(JSON.stringify(canonicalizePortableInvestigation(resealed))).toBe(
      JSON.stringify(canonicalizePortableInvestigation(sealed)),
    );
    expect(parsePortableInvestigation(structuredClone(sealed)).bundleFingerprint).toBe(
      sealed.bundleFingerprint,
    );
  });

  it("rejects objectHash and bundleFingerprint tampering", () => {
    const fp = syntheticSeal();
    fp.bundleFingerprint = "aa".repeat(32);
    expect(() => parsePortableInvestigation(fp)).toThrow(/hash\/fingerprint mismatch/);
    const obj = syntheticSeal();
    obj.investigation.objectHash = "bb".repeat(32);
    expect(() => parsePortableInvestigation(obj)).toThrow(/hash\/fingerprint mismatch/);
  });

  it("rejects duplicate ids and dangling refs across every major family", () => {
    const dupActor = syntheticSeal();
    dupActor.actors.push({ ...dupActor.actors[0]! });
    expect(() => parsePortableInvestigation(dupActor)).toThrow(/duplicate id/);

    const danglingParticipant = syntheticSeal();
    danglingParticipant.participants[1]!.sourceActorId = "ghost-operator";
    expect(() => parsePortableInvestigation(reseal(danglingParticipant))).toThrow(/dangling actor/);

    const danglingSource = syntheticSeal();
    danglingSource.contributions[0]!.sourceId = "ghost-source";
    expect(() => parsePortableInvestigation(reseal(danglingSource))).toThrow(/dangling source/);

    const danglingEvidence = syntheticSeal();
    danglingEvidence.snapshots[0]!.evidence[0]!.evidenceId = "ghost-evidence";
    danglingEvidence.snapshots[0]!.fingerprint = portableSnapshotFingerprint(
      danglingEvidence.snapshots[0]!,
    );
    expect(() => parsePortableInvestigation(reseal(danglingEvidence))).toThrow(/dangling evidence/);

    const danglingJob = syntheticSeal();
    danglingJob.triageJobs[0]!.snapshotId = "ghost-snap";
    expect(() => parsePortableInvestigation(reseal(danglingJob))).toThrow(/dangling snapshot/);

    const danglingHelp = syntheticSeal();
    danglingHelp.helpfulnessObservations[0]!.experimentId = "ghost-exp";
    expect(() => parsePortableInvestigation(reseal(danglingHelp))).toThrow(/dangling experiment/);

    const danglingDecisionEv = syntheticSeal();
    danglingDecisionEv.decisions[0]!.evidenceRefs = ["ghost-ev"];
    expect(() => parsePortableInvestigation(reseal(danglingDecisionEv))).toThrow(
      /dangling evidence/,
    );

    const danglingGold = syntheticSeal();
    danglingGold.alignments[0]!.goldId = "ghost-gold";
    expect(() => parsePortableInvestigation(reseal(danglingGold))).toThrow(/dangling gold/);

    const danglingDisc = syntheticSeal();
    danglingDisc.discussions[0]!.messageIds = ["ghost-note"];
    expect(() => parsePortableInvestigation(reseal(danglingDisc))).toThrow(/dangling contribution/);

    const danglingAttach = syntheticSeal();
    danglingAttach.attachments[0]!.discussionId = "ghost-disc";
    expect(() => parsePortableInvestigation(reseal(danglingAttach))).toThrow(/dangling discussion/);

    const danglingTimeline = syntheticSeal();
    danglingTimeline.timeline[0]!.targetId = "ghost-note";
    expect(() => parsePortableInvestigation(reseal(danglingTimeline))).toThrow(/dangling/);

    const danglingAudit = syntheticSeal();
    danglingAudit.auditRefs[0]!.actorId = "ghost-operator";
    expect(() => parsePortableInvestigation(reseal(danglingAudit))).toThrow(/dangling actor/);
  });

  it("resolves all portable timeline namespaces and enforces target null parity", () => {
    const sealed = syntheticSeal();
    const targets = [
      ["investigation", sealed.investigation.id],
      ["actor", sealed.actors[0]!.sourceActorId],
      ["contribution", sealed.contributions[0]!.id],
      ["evidence", sealed.evidence[0]!.id],
      ["content", sealed.contentObjects[0]!.digest],
      ["source", sealed.sources[0]!.id],
      ["imported_ai_run", sealed.importedAiRuns[0]!.id],
      ["snapshot", sealed.snapshots[0]!.id],
      ["triage_job", sealed.triageJobs[0]!.id],
      ["experiment", sealed.experiments[0]!.id],
      ["helpfulness", sealed.helpfulnessObservations[0]!.id],
      ["decision", sealed.decisions[0]!.id],
      ["gold", sealed.gold[0]!.goldId],
      ["alignment", sealed.alignments[0]!.id],
      ["discussion", sealed.discussions[0]!.id],
      ["timeline", String(sealed.timeline[0]!.seq)],
      ["audit", sealed.auditRefs[0]!.id],
      ["attachment", sealed.attachments[0]!.id],
    ] as const;

    for (const [namespace, targetId] of targets) {
      const row = structuredClone(sealed);
      row.timeline[0]!.targetNamespace = namespace;
      row.timeline[0]!.targetId = targetId;
      expect(() => parsePortableInvestigation(reseal(row)), namespace).not.toThrow();
    }

    const report = preflightPortableInvestigation(sealed, dryRun(sealed));
    expect(new Set(report.idRemap.map((row) => row.namespace))).toEqual(
      new Set(targets.map(([namespace]) => namespace)),
    );

    const missingId = structuredClone(sealed);
    missingId.timeline[0]!.targetId = null;
    expect(() => parsePortableInvestigation(reseal(missingId))).toThrow(/both be null|both be set/);

    const missingNamespace = structuredClone(sealed);
    missingNamespace.timeline[0]!.targetNamespace = null;
    expect(() => parsePortableInvestigation(reseal(missingNamespace))).toThrow(
      /both be null|both be set/,
    );

    const unknownNamespace = structuredClone(sealed);
    unknownNamespace.timeline[0]!.targetNamespace = "synthetic_unknown";
    expect(() => parsePortableInvestigation(reseal(unknownNamespace))).toThrow(
      /unknown timeline target namespace/,
    );
  });

  it("rejects broken contribution, decision, and complete gold lineage failures", () => {
    const contrib = syntheticSeal();
    contrib.contributions[0]!.revision = 2;
    contrib.contributions[0]!.predecessorRevision = 1;
    expect(() => parsePortableInvestigation(reseal(contrib))).toThrow(/corrupt version chain/);

    const decision = syntheticSeal();
    decision.decisions[0]!.revision = 2;
    decision.decisions[0]!.predecessorRevision = 1;
    expect(() => parsePortableInvestigation(reseal(decision))).toThrow(/corrupt version chain/);

    const ghost = syntheticSeal();
    const v1 = ghost.gold[0]!;
    ghost.gold.push({
      ...v1,
      goldId: "gold-ghost-successor",
      version: 2,
      predecessorGoldId: "ghost-gold-not-in-bundle",
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(ghost))).toThrow(/dangling gold predecessor/);

    const validChain = syntheticSeal();
    const validBase = validChain.gold[0]!;
    validChain.gold.push({
      ...validBase,
      goldId: "gold-human-2",
      version: 2,
      predecessorGoldId: validBase.goldId,
      objectHash: Z,
    });
    validChain.gold.push({
      ...validBase,
      goldId: "gold-human-3",
      version: 3,
      predecessorGoldId: "gold-human-2",
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(validChain))).not.toThrow();

    const duplicateId = syntheticSeal();
    duplicateId.gold.push({
      ...duplicateId.gold[0]!,
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(duplicateId))).toThrow(/duplicate id/);

    const self = syntheticSeal();
    self.gold.push({
      ...self.gold[0]!,
      goldId: "gold-self",
      version: 2,
      predecessorGoldId: "gold-self",
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(self))).toThrow(/self-reference/);

    const cycle = syntheticSeal();
    cycle.gold.push({
      ...cycle.gold[0]!,
      goldId: "gold-cycle-a",
      version: 2,
      predecessorGoldId: "gold-cycle-b",
      objectHash: Z,
    });
    cycle.gold.push({
      ...cycle.gold[0]!,
      goldId: "gold-cycle-b",
      version: 3,
      predecessorGoldId: "gold-cycle-a",
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(cycle))).toThrow(/cyclic gold predecessor/);

    const fork = syntheticSeal();
    const base = fork.gold[0]!;
    fork.gold.push({
      ...base,
      goldId: "gold-fork-a",
      version: 2,
      predecessorGoldId: base.goldId,
      objectHash: Z,
    });
    fork.gold.push({
      ...base,
      goldId: "gold-fork-b",
      version: 2,
      predecessorGoldId: base.goldId,
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(fork))).toThrow(/gold predecessor fork/);

    const duplicateVersion = syntheticSeal();
    const duplicateBase = duplicateVersion.gold[0]!;
    duplicateVersion.gold.push({
      ...duplicateBase,
      goldId: "gold-version-a",
      version: 2,
      predecessorGoldId: duplicateBase.goldId,
      objectHash: Z,
    });
    duplicateVersion.gold.push({
      ...duplicateBase,
      goldId: "gold-version-b",
      version: 2,
      predecessorGoldId: "gold-version-a",
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(duplicateVersion))).toThrow(
      /duplicate version/,
    );

    const nonAdjacent = syntheticSeal();
    nonAdjacent.gold.push({
      ...nonAdjacent.gold[0]!,
      goldId: "gold-version-3",
      version: 3,
      predecessorGoldId: nonAdjacent.gold[0]!.goldId,
      objectHash: Z,
    });
    expect(() => parsePortableInvestigation(reseal(nonAdjacent))).toThrow(/must be adjacent/);
  });

  it("rejects snapshot fingerprint, ordinal, privacy, fairness, lineage, and parent self-reference dishonesty", () => {
    const fp = syntheticSeal();
    fp.snapshots[0]!.fingerprint = "cc".repeat(32);
    expect(() => parsePortableInvestigation(fp)).toThrow(/hash\/fingerprint mismatch/);

    const ordinal = syntheticSeal();
    ordinal.snapshots[0]!.evidence.push({
      evidenceId: "ev-restricted-1",
      ordinal: 0,
      contentHash: ordinal.evidence[1]!.digest,
      privacyClass: "owner_only",
    });
    expect(() => parsePortableInvestigation(reseal(ordinal))).toThrow(/duplicate ordinal|illegal privacy/);

    const privacy = syntheticSeal();
    privacy.snapshots[0]!.evidence.push({
      evidenceId: "ev-restricted-1",
      ordinal: 1,
      contentHash: privacy.evidence[1]!.digest,
      privacyClass: "owner_only",
    });
    privacy.snapshots[0]!.fingerprint = portableSnapshotFingerprint(privacy.snapshots[0]!);
    expect(() => parsePortableInvestigation(reseal(privacy))).toThrow(/illegal privacy claim/);

    const fairness = syntheticSeal();
    fairness.snapshots[0]!.evidence[0]!.contentHash = null;
    fairness.snapshots[0]!.fairnessClass = "same_snapshot";
    fairness.snapshots[0]!.fingerprint = portableSnapshotFingerprint(fairness.snapshots[0]!);
    expect(() => parsePortableInvestigation(reseal(fairness))).toThrow(/hash\/fingerprint mismatch/);

    const lineage = syntheticSeal();
    lineage.snapshots[0]!.lineageClass = "derived";
    expect(() => parsePortableInvestigation(reseal(lineage))).toThrow(/derived lineage requires a parent/);

    const selfRef = syntheticSeal();
    selfRef.snapshots[0]!.parentSnapshotId = selfRef.snapshots[0]!.id;
    selfRef.snapshots[0]!.lineageClass = "derived";
    expect(() => parsePortableInvestigation(reseal(selfRef))).toThrow(/self\/cyclic lineage/);
  });

  it("rejects content digest, byte-length, and payload dishonesty including duplicate digests", () => {
    const digest = syntheticSeal();
    const present = digest.contentObjects.find((row) => row.inclusion === "present")!;
    present.digest = "dd".repeat(32);
    expect(() => parsePortableInvestigation(reseal(digest))).toThrow(
      /hash\/fingerprint mismatch|dangling content/,
    );

    const length = syntheticSeal();
    const payload = length.contentObjects.find((row) => row.inclusion === "present")!;
    payload.byteLength = payload.byteLength + 8;
    expect(() => parsePortableInvestigation(reseal(length))).toThrow(/payload length mismatch|byteLength/);

    const omittedPayload = syntheticSeal();
    const priv = omittedPayload.contentObjects.find((row) => row.inclusion === "private")!;
    priv.payloadBase64 = Buffer.from("synth-restricted-bytes").toString("base64");
    expect(() => parsePortableInvestigation(reseal(omittedPayload))).toThrow(
      /must not include payload/,
    );

    const missing = syntheticSeal();
    const open = missing.contentObjects.find((row) => row.inclusion === "present")!;
    open.payloadBase64 = null;
    expect(() => parsePortableInvestigation(reseal(missing))).toThrow(/missing required content/);

    const dup = syntheticSeal();
    dup.contentObjects.push({ ...dup.contentObjects[0]! });
    expect(() => parsePortableInvestigation(reseal(dup))).toThrow(/duplicate id/);
  });

  it("rejects credential, LDAP, endpoint, path, token, and secret leakage in keys and opaque JSON", () => {
    const keyLeak = syntheticSeal();
    (keyLeak as unknown as Record<string, unknown>).gatewaySecret = "not-a-real-secret";
    expect(() => parsePortableInvestigation(keyLeak)).toThrow(/unknown key|forbidden credential/);

    const tokenOpaque = syntheticSeal();
    tokenOpaque.importedAiRuns[0]!.opaquePayloadJson = '{"token":"sk-not-a-real-key"}';
    expect(() => parsePortableInvestigation(reseal(tokenOpaque))).toThrow(
      /forbidden credential|credential, token, secret, or live endpoint leakage/,
    );

    const ldapOpaque = syntheticSeal();
    ldapOpaque.importedAiRuns[0]!.opaquePayloadJson = '{"note":"ldap://synth-directory.invalid"}';
    expect(() => parsePortableInvestigation(reseal(ldapOpaque))).toThrow(
      /ldap|credential|endpoint|leakage/i,
    );

    const urlOpaque = syntheticSeal();
    urlOpaque.importedAiRuns[0]!.opaquePayloadJson =
      '{"note":"https://synthetic-gateway.invalid/v1"}';
    expect(() => parsePortableInvestigation(reseal(urlOpaque))).toThrow(
      /endpoint|url|leakage|credential/i,
    );

    const unsafeOpaquePayloads = [
      JSON.stringify({ note: "//synthetic-gateway.invalid/v1" }),
      JSON.stringify({ note: "../synthetic/private-config" }),
      JSON.stringify({ note: "/synthetic/private-config" }),
      JSON.stringify({ note: "~/synthetic/private-config" }),
      JSON.stringify({ note: "X:\\synthetic\\private-config" }),
      JSON.stringify({ note: "\\\\synthetic-node\\share" }),
      JSON.stringify({ "//synthetic-gateway.invalid/v1": "synthetic" }),
      JSON.stringify({ "../synthetic/private-config": "synthetic" }),
    ];
    for (const [index, opaquePayloadJson] of unsafeOpaquePayloads.entries()) {
      const unsafe = syntheticSeal();
      unsafe.importedAiRuns[0]!.opaquePayloadJson = opaquePayloadJson;
      expect(() => parsePortableInvestigation(reseal(unsafe)), String(index)).toThrow(
        /endpoint|url|path/i,
      );
    }

    const normalProse = syntheticSeal();
    normalProse.importedAiRuns[0]!.opaquePayloadJson =
      '{"label":"synthetic note","note":"Compare 1/2 and/or A/B. Double slash // is punctuation; use / as a separator."}';
    expect(() => parsePortableInvestigation(reseal(normalProse))).not.toThrow();
  });

  it("never authorizes identity by display name or email and never grants destination permissions", () => {
    const sealed = syntheticSeal();
    const north = sealed.actors[0]!;
    const report = preflightPortableInvestigation(
      sealed,
      dryRun(sealed, {
        destination: {
          identities: [
            {
              actorId: "dest-north",
              username: north.username,
              email: "northbound@synthetic.invalid",
              displayName: north.displayName,
            },
          ],
          objectIds: {},
          knownProfileIds: ["profile-synth-a"],
        },
      }),
    );
    const resolution = report.identityResolutions.find(
      (row) => row.sourceActorId === north.sourceActorId,
    );
    expect(resolution?.action).toBe("leave_unresolved");
    expect(resolution?.destinationActorId).toBeNull();
    expect(report.applyAuthorized).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/permission granted/i);
    expect(report.warnings.some((row) => row.code === "identity_name_collision")).toBe(true);

    expect(() =>
      preflightPortableInvestigation(sealed, { ...dryRun(sealed), identityMap: [] }),
    ).toThrow(/identity-map ambiguity/);

    const conflict = dryRun(sealed, {
      identityMap: sealed.actors.map((actor) => ({
        sourceActorId: actor.sourceActorId,
        action: "map_existing" as const,
        destinationActorId: "dest-shared",
      })),
      destination: {
        identities: [
          {
            actorId: "dest-shared",
            username: "shared",
            email: null,
            displayName: "Shared",
          },
        ],
        objectIds: {},
        knownProfileIds: ["profile-synth-a"],
      },
    });
    expect(() => preflightPortableInvestigation(sealed, conflict)).toThrow(/identity-map ambiguity/);
  });

  it("handles destination id collisions under fail and deterministic-remap stably and namespace-safely", () => {
    const sealed = syntheticSeal();
    const colliding = dryRun(sealed, {
      collisionPolicy: "fail",
      destination: {
        identities: [],
        objectIds: { investigation: [sealed.investigation.id] },
        knownProfileIds: ["profile-synth-a"],
      },
    });
    const failed = preflightPortableInvestigation(sealed, colliding);
    expect(failed.counts.conflict).toBeGreaterThan(0);
    expect(failed.counts.blocked).toBeGreaterThan(0);
    expect(failed.referentialIntegrityFailures.some((row) => row.code === "id_collision")).toBe(
      true,
    );
    expect(failed.reconstructionStatus).toBe("blocked");
    expect(failed.reconstructionReasons.some((row) => row.code === "id_collision")).toBe(true);

    const remapReq = dryRun(sealed, {
      collisionPolicy: "remap_deterministic",
      destination: {
        identities: [],
        objectIds: { investigation: [sealed.investigation.id] },
        knownProfileIds: ["profile-synth-a"],
      },
    });
    const first = preflightPortableInvestigation(sealed, remapReq);
    const reversed = dryRun(sealed, {
      collisionPolicy: "remap_deterministic",
      identityMap: [...dryRun(sealed).identityMap].reverse(),
      destination: {
        identities: [],
        objectIds: { investigation: [...(remapReq.destination.objectIds.investigation ?? [])] },
        knownProfileIds: ["profile-synth-a"],
      },
    });
    const second = preflightPortableInvestigation(sealed, reversed);
    expect(first.idRemap.map(remapKey).sort()).toEqual(second.idRemap.map(remapKey).sort());
    const inv = first.idRemap.find((row) => row.namespace === "investigation");
    expect(inv?.destinationId.startsWith("remap-")).toBe(true);
    const contrib = first.idRemap.find((row) => row.namespace === "contribution");
    const evidence = first.idRemap.find((row) => row.namespace === "evidence");
    expect(contrib && evidence).toBeTruthy();
    expect(contrib?.destinationId).not.toBe(evidence?.destinationId);
    expect(first.idRemap.length).toBe(second.idRemap.length);
    expect(first.idRemap.length).toBeGreaterThan(10);
  });

  it("chooses an unoccupied deterministic fallback and fails closed when its bounded space is exhausted", () => {
    const sealed = syntheticSeal();
    const sourceId = sealed.investigation.id;
    const occupiedFirst = remapCandidate(
      sealed.sourceInstallationId,
      "investigation",
      sourceId,
      0,
    );
    const expectedFallback = remapCandidate(
      sealed.sourceInstallationId,
      "investigation",
      sourceId,
      1,
    );
    const request = dryRun(sealed, {
      collisionPolicy: "remap_deterministic",
      destination: {
        identities: [],
        objectIds: { investigation: [sourceId, occupiedFirst] },
        knownProfileIds: ["profile-synth-a"],
      },
    });

    const first = preflightPortableInvestigation(sealed, request);
    const second = preflightPortableInvestigation(sealed, structuredClone(request));
    const investigation = first.idRemap.find((row) => row.namespace === "investigation");
    expect(investigation?.destinationId).toBe(expectedFallback);
    expect(second.idRemap).toEqual(first.idRemap);
    expect(first.counts.blocked).toBe(0);
    expect(first.counts.conflict).toBe(0);
    expect(first.exactReconstruction).toBe(false);
    expect(first.reconstructionStatus).toBe("metadata_only");

    const exhausted = dryRun(sealed, {
      collisionPolicy: "remap_deterministic",
      destination: {
        identities: [],
        objectIds: {
          investigation: [
            sourceId,
            ...Array.from({ length: 256 }, (_, attempt) =>
              remapCandidate(
                sealed.sourceInstallationId,
                "investigation",
                sourceId,
                attempt,
              ),
            ),
          ],
        },
        knownProfileIds: ["profile-synth-a"],
      },
    });
    expect(() => preflightPortableInvestigation(sealed, exhausted)).toThrow(
      /deterministic remap space exhausted/,
    );
  });

  it("uses locale-independent code-unit ordering for Unicode ids and canonical output", () => {
    const unicode = syntheticSeal();
    const baseAudit = unicode.auditRefs[0]!;
    unicode.auditRefs.push(
      { ...baseAudit, id: "aud-zulu", objectHash: Z },
      { ...baseAudit, id: "aud-\u00e4ther", objectHash: Z },
    );
    const reversed = structuredClone(unicode);
    reversed.auditRefs.reverse();

    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not affect portable output");
      });
    let first: PortableInvestigationV1;
    let second: PortableInvestigationV1;
    let report: ReturnType<typeof preflightPortableInvestigation>;
    try {
      first = reseal(unicode);
      second = reseal(reversed);
      report = preflightPortableInvestigation(first, dryRun(first));
    } finally {
      localeCompare.mockRestore();
    }

    expect(first.bundleFingerprint).toBe(second.bundleFingerprint);
    expect(first.objectHashes).toEqual(second.objectHashes);
    expect(first.auditRefs.map((row) => row.id)).toEqual([
      "aud-export-1",
      "aud-zulu",
      "aud-\u00e4ther",
    ]);
    expect(
      report.idRemap
        .filter((row) => row.namespace === "audit")
        .map((row) => row.sourceId),
    ).toEqual(["aud-export-1", "aud-zulu", "aud-\u00e4ther"]);
  });

  it("isolates identifier controls from prose and rejects them in nested ids", () => {
    const prose = syntheticSeal();
    prose.investigation.title = "Synthetic title\nwith a tab\tand ordinary prose";
    expect(() => parsePortableInvestigation(reseal(prose))).not.toThrow();

    const empty = syntheticSeal();
    empty.investigation.id = "   ";
    expect(() => parsePortableInvestigation(reseal(empty))).toThrow(/must not be empty/);

    const nul = syntheticSeal();
    nul.investigation.id = "inv-\u0000hidden";
    expect(() => parsePortableInvestigation(reseal(nul))).toThrow(
      /must not be empty|control|identifier/,
    );

    const zw = syntheticSeal();
    zw.actors[0]!.sourceActorId = "\u200b";
    expect(() => parsePortableInvestigation(reseal(zw))).toThrow(
      /must not be empty|control|identifier|dangling/,
    );

    const strategy = syntheticSeal();
    strategy.triageJobs[0]!.strategyId = "strategy-\u0000hidden";
    expect(() => parsePortableInvestigation(reseal(strategy))).toThrow(/control|identifier/);

    const packageId = syntheticSeal();
    packageId.experiments[0]!.packageId = "package-\u2060hidden";
    expect(() => parsePortableInvestigation(reseal(packageId))).toThrow(/control|zero-width/);

    const profile = syntheticSeal();
    profile.importedAiRuns[0]!.profileId = "profile-\u200bhidden";
    expect(() => parsePortableInvestigation(reseal(profile))).toThrow(/control|zero-width/);

    const requestProfile = syntheticSeal();
    const request = dryRun(requestProfile);
    request.destination.knownProfileIds = ["profile-\u200bhidden"];
    expect(() => preflightPortableInvestigation(requestProfile, request)).toThrow(
      /control|zero-width/,
    );

    const destinationObject = dryRun(requestProfile);
    destinationObject.destination.objectIds = { evidence: ["evidence-\u0000hidden"] };
    expect(() => preflightPortableInvestigation(requestProfile, destinationObject)).toThrow(
      /control|identifier/,
    );

    const formatControl = syntheticSeal();
    formatControl.triageJobs[0]!.strategyId = "strategy-\u{e0100}hidden";
    expect(() => parsePortableInvestigation(reseal(formatControl))).toThrow(
      /control|zero-width/,
    );
  });

  it("rejects unsafe timestamps and non-integers", () => {
    const ts = syntheticSeal();
    ts.exportedAt = "not-a-timestamp";
    expect(() => parsePortableInvestigation(ts)).toThrow(/RFC3339/);

    const frac = syntheticSeal();
    (frac.contributions[0] as { revision: number }).revision = 1.5;
    expect(() => parsePortableInvestigation(frac)).toThrow(/unsigned safe integer|corrupt/);
  });

  it("keeps provider and model metadata historical without destination credentials, usage, or cost claims", () => {
    const sealed = syntheticSeal();
    expect(sealed.importedAiRuns[0]?.usageStatus).toBe("unknown");
    expect(sealed.importedAiRuns[0]?.costStatus).toBe("unknown");
    const invented = syntheticSeal();
    (invented.importedAiRuns[0] as { usageStatus: string }).usageStatus = "tokens_99";
    expect(() => parsePortableInvestigation(invented)).toThrow(/unknown/);
    const report = preflightPortableInvestigation(sealed, dryRun(sealed));
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/"apiKey"/);
    expect(text).not.toMatch(/"endpoint"/);
    expect(text).not.toMatch(/"ldap"/);
    expect(report.applyAuthorized).toBe(false);
  });

  it("invalidates per-object hash and bundle fingerprint when one object mutates", () => {
    const before = syntheticSeal();
    const mutated = structuredClone(before);
    mutated.investigation.title = "Synthetic retitled investigation";
    const after = reseal(mutated);
    expect(after.investigation.objectHash).not.toBe(before.investigation.objectHash);
    expect(after.bundleFingerprint).not.toBe(before.bundleFingerprint);
    expect(() => parsePortableInvestigation({ ...after, bundleFingerprint: before.bundleFingerprint })).toThrow(
      /hash\/fingerprint mismatch/,
    );
  });
});
