import { Pool } from "pg";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  PORTABLE_OBJECT_KINDS,
  portableDestinationUuid,
  snapshotFairness,
  snapshotFingerprint,
  type ArchivePreflightReportV1,
  type GoldReferenceV1,
  type HelpfulnessObservationV1,
  type IdentityMapEntryV1,
  type NormalizedExperimentDecisionV1,
  type PortableArchiveV1,
  type PortableObjectKind,
  type TriageJobV1,
} from "@cd-collab/contracts";
import type { EvidenceStore } from "../../evidence/store.js";
import { PgAuditStore, type AuditStore } from "../audit/index.js";
import { PgCatalogStore, type CatalogStore } from "../catalog/index.js";
import { PgCaseStore, type Actor, type CaseStore } from "../cases/index.js";
import { PgExperimentStore, type ExperimentStore } from "../experiments/index.js";
import { PgRunStore, type RunStore } from "../import/index.js";
import { PgTriageJobStore, type TriageJobStore } from "../triage-runs/index.js";

export interface PortablePersistPorts {
  cases: CaseStore;
  catalog: CatalogStore;
  experiments: ExperimentStore;
  runs: RunStore;
  jobs: TriageJobStore;
  evidence: EvidenceStore;
  audit: AuditStore;
}

type CaseRow = Parameters<CaseStore["insertCase"]>[0];
type RevisionRow = Parameters<CaseStore["insertRevision"]>[0];
type ArtifactRow = Parameters<CaseStore["insertArtifact"]>[0];
type SourceRow = Parameters<CatalogStore["insert"]>[0];
type FrozenRunRow = Parameters<RunStore["insert"]>[0];
type ExperimentRow = Parameters<ExperimentStore["insert"]>[0];

interface Capturable {
  capture(): unknown;
  restore(snapshot: unknown): void | Promise<void>;
}

export interface MemoryApplyBoundary {
  persist: PortablePersistPorts;
  snapshot: () => Promise<unknown>;
  restore: (snapshot: unknown) => Promise<void>;
}

function remapOf(
  report: ArchivePreflightReportV1,
  kind: PortableObjectKind,
  sourceId: string,
): string {
  const hit = report.idRemap.find((row) => row.namespace === kind && row.sourceId === sourceId);
  return hit?.destinationId ?? sourceId;
}

function actorAttribution(
  sourceActorId: string,
  identityMap: IdentityMapEntryV1[],
  report: ArchivePreflightReportV1,
  archive: PortableArchiveV1,
): { id: string; username: string } {
  const mapped = identityMap.find((row) => row.sourceActorId === sourceActorId);
  const snapshot = archive.investigation.actors.find((row) => row.sourceActorId === sourceActorId);
  const username = snapshot?.username || snapshot?.displayName || "historical-operator";
  if (mapped?.action === "map_existing" && mapped.destinationActorId) {
    return { id: mapped.destinationActorId, username };
  }
  return { id: remapOf(report, "actor", sourceActorId), username };
}

function asCapturable(store: object): Capturable {
  const candidate = store as Capturable;
  if (typeof candidate.capture !== "function" || typeof candidate.restore !== "function") {
    throw new Error("apply snapshot requires capture/restore on memory stores");
  }
  return candidate;
}

export function memoryApplyBoundary(input: {
  cases: CaseStore;
  catalog: CatalogStore;
  experiments: ExperimentStore;
  runs: RunStore;
  jobs: TriageJobStore;
  evidence: EvidenceStore;
  audit: AuditStore;
}): MemoryApplyBoundary {
  const cases = asCapturable(input.cases);
  const catalog = asCapturable(input.catalog);
  const experiments = asCapturable(input.experiments);
  const runs = asCapturable(input.runs);
  const jobs = asCapturable(input.jobs);
  const audit = asCapturable(input.audit);
  return {
    persist: input,
    snapshot: async () => ({
      cases: await Promise.resolve(cases.capture()),
      catalog: await Promise.resolve(catalog.capture()),
      experiments: await Promise.resolve(experiments.capture()),
      runs: await Promise.resolve(runs.capture()),
      jobs: await Promise.resolve(jobs.capture()),
      audit: await Promise.resolve(audit.capture()),
    }),
    restore: async (snapshot: unknown) => {
      const row = snapshot as {
        cases: unknown;
        catalog: unknown;
        experiments: unknown;
        runs: unknown;
        jobs: unknown;
        audit: unknown;
      };
      await Promise.resolve(cases.restore(row.cases));
      await Promise.resolve(catalog.restore(row.catalog));
      await Promise.resolve(experiments.restore(row.experiments));
      await Promise.resolve(runs.restore(row.runs));
      await Promise.resolve(jobs.restore(row.jobs));
      await Promise.resolve(audit.restore(row.audit));
    },
  };
}

export async function withPgApplyTransaction<T>(
  db: Pool | Pick<Pool, "query">,
  evidence: EvidenceStore,
  operation: (ports: PortablePersistPorts) => Promise<T>,
): Promise<T> {
  const pooled = db instanceof Pool ? await db.connect() : null;
  const tx = pooled ?? db;
  await tx.query("BEGIN");
  try {
    const result = await operation({
      cases: new PgCaseStore(tx),
      catalog: new PgCatalogStore(tx),
      experiments: new PgExperimentStore(tx),
      runs: new PgRunStore(tx),
      jobs: new PgTriageJobStore(tx),
      evidence,
      audit: new PgAuditStore(tx),
    });
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch {
      // Preserve the mutation failure.
    }
    throw error;
  } finally {
    pooled?.release();
  }
}

export async function persistPortableArchive(input: {
  archive: PortableArchiveV1;
  report: ArchivePreflightReportV1;
  identityMap: IdentityMapEntryV1[];
  actor: Actor;
  ports: PortablePersistPorts;
  now: string;
  origin?: string;
}): Promise<string> {
  const { archive, report, identityMap, actor, ports, now } = input;
  const investigationId = remapOf(
    report,
    "investigation",
    archive.investigation.investigation.id,
  );
  const bundle = archive.investigation;
  const caseRow: CaseRow = {
    id: investigationId,
    title: bundle.investigation.title,
    problemStatement: bundle.investigation.problemStatement,
    affectedParties: bundle.investigation.affectedParties,
    impact: bundle.investigation.impact,
    scope: bundle.investigation.scope,
    openQuestions: [...bundle.investigation.openQuestions],
    situationVersion: bundle.investigation.situationVersion,
    severity: bundle.investigation.severity,
    status: bundle.investigation.status,
    legalHold: bundle.investigation.legalHold,
    retentionClass: bundle.investigation.retentionClass,
    createdAt: bundle.investigation.createdAt,
    createdBy: actor.id,
    createdByUsername: actor.username,
    participants: [{ identityId: actor.id, username: actor.username }],
  };
  await ports.cases.insertCase(caseRow);
  await ports.cases.appendTimeline(investigationId, {
    kind: "portable_archive_applied",
    actor,
    targetId: investigationId,
    clientTime: null,
    payload: {
      sourceInstallationId: bundle.sourceInstallationId,
      transportHash: archive.transportHash,
      semanticFingerprint: archive.semanticFingerprint,
      sourceInvestigationId: bundle.investigation.id,
      appliedAt: now,
    },
  });

  for (const source of bundle.sources) {
    const id = remapOf(report, "source", source.id);
    const existing = await ports.catalog.get(id);
    if (existing) continue;
    const createdBy = actorAttribution(source.createdBy, identityMap, report, archive);
    const row: SourceRow = {
      id,
      name: source.name,
      kind: source.kind,
      description: null,
      lifecycle: source.lifecycle,
      identityId: null,
      createdAt: source.createdAt,
      createdBy: createdBy.id,
    };
    await ports.catalog.insert(row);
  }

  const fallbackSourceId = bundle.sources[0]
    ? remapOf(report, "source", bundle.sources[0].id)
    : PERMANENT_UNKNOWN_SOURCE_ID;

  for (const contribution of [...bundle.contributions].sort(
    (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision,
  )) {
    const author = actorAttribution(contribution.authorId, identityMap, report, archive);
    const rev: RevisionRow = {
      contributionId: remapOf(report, "contribution", contribution.id),
      caseId: investigationId,
      kind: contribution.kind,
      revision: contribution.revision,
      predecessorRevision: contribution.predecessorRevision,
      body: contribution.body ?? "",
      contentHash: contribution.contentHash,
      privacyClass: contribution.privacyClass,
      tombstone: contribution.tombstoned,
      authorId: author.id,
      authorUsername: author.username,
      createdAt: contribution.createdAt,
      hypothesisStatus: contribution.hypothesisStatus,
      hypothesisLinks: [],
      sourceId: remapOf(report, "source", contribution.sourceId),
    };
    await ports.cases.insertRevision(rev);
  }

  const digestBytes = new Map<string, Uint8Array>();
  for (const content of bundle.contentObjects) {
    if (content.inclusion === "present" && content.payloadBase64) {
      const bytes = Buffer.from(content.payloadBase64, "base64");
      const stored = await ports.evidence.put(bytes, {
        contentType: content.contentType ?? "application/octet-stream",
      });
      if (stored.hash !== content.digest || stored.byteLength !== content.byteLength) {
        throw new Error("imported evidence digest mismatch");
      }
      digestBytes.set(content.digest, bytes);
    }
  }

  for (const evidence of bundle.evidence) {
    const id = remapOf(report, "evidence", evidence.id);
    const uploader = actorAttribution(evidence.createdBy, identityMap, report, archive);
    const row: ArtifactRow = {
      id,
      caseId: investigationId,
      kind: "log",
      filename: evidence.title,
      uri: null,
      mediaType: evidence.contentType,
      byteLength: evidence.byteLength,
      contentHash: digestBytes.has(evidence.digest) ? evidence.digest : null,
      expectedHash: evidence.digest,
      verificationStatus: digestBytes.has(evidence.digest) ? "verified" : "unverified",
      refId: null,
      privacyClass: evidence.privacyClass,
      summaryContributionId: null,
      uploaderId: uploader.id,
      uploaderUsername: uploader.username,
      sourceId: fallbackSourceId,
    };
    await ports.cases.insertArtifact(row);
  }

  const destSnapshotFingerprints = new Map<string, string>();
  for (const snap of bundle.snapshots) {
    const evidence = snap.evidence.map((item, ordinal) => ({
      evidenceId: remapOf(report, "evidence", item.evidenceId),
      ordinal,
      contentHash: item.contentHash,
      expectedHash: item.contentHash,
      verificationStatus: item.contentHash ? "verified" : null,
      privacyClass: item.privacyClass,
    }));
    const parentSnapshotId = snap.parentSnapshotId
      ? remapOf(report, "snapshot", snap.parentSnapshotId)
      : null;
    const fingerprint = snapshotFingerprint({
      parentSnapshotId,
      evidence,
      visibility: snap.visibility,
      protocolVersion: snap.protocolVersion,
    });
    destSnapshotFingerprints.set(snap.id, fingerprint);
    await ports.cases.insertSnapshot({
      schemaId: "cd-collab.snapshot.v1",
      id: remapOf(report, "snapshot", snap.id),
      caseId: investigationId,
      fingerprint,
      parentSnapshotId,
      evidence,
      visibility: snap.visibility,
      protocolVersion: snap.protocolVersion,
      fairnessClass: snapshotFairness(evidence),
      status: "frozen",
      createdAt: snap.createdAt,
      createdBy: actorAttribution(snap.createdBy, identityMap, report, archive).id,
    });
  }

  for (const run of bundle.importedAiRuns) {
    const output = digestBytes.get(run.outputDigest ?? "") ?? new Uint8Array();
    const outputText = Buffer.from(output).toString("utf8");
    const row: FrozenRunRow = {
      id: remapOf(report, "imported_ai_run", run.id),
      caseId: investigationId,
      contributionId: bundle.contributions[0]
        ? remapOf(report, "contribution", bundle.contributions[0].id)
        : investigationId,
      sourceId: remapOf(report, "source", run.sourceId),
      outputHash: run.outputDigest ?? "00".repeat(32),
      outputText,
      promptHash: null,
      promptText: null,
      promptCompleteness: "unknown",
      outputCompleteness: "unknown",
      workflowCompleteness: "unknown",
      evidenceVisibility: "unknown",
      snapshotBinding: null,
      visibilityNote: null,
      importerId: actor.id,
      importerUsername: actor.username,
      operatorId: actor.id,
      operatorUsername: actor.username,
      provider: run.providerKind,
      model: run.model,
      version: run.version,
      claimedTraces: [],
      uncertainty: null,
      timing: null,
      cost: null,
      redacted: false,
      privacyClass: "owner_only",
      createdAt: run.importedAt,
    };
    await ports.runs.insert(row);
  }

  for (const job of bundle.triageJobs) {
    const snapshotFingerprintValue =
      destSnapshotFingerprints.get(job.snapshotId) ?? job.snapshotFingerprint;
    const row: TriageJobV1 = {
      schemaId: "cd-collab.triage_job.v1",
      id: remapOf(report, "triage_job", job.id),
      caseId: investigationId,
      snapshotId: remapOf(report, "snapshot", job.snapshotId),
      snapshotFingerprint: snapshotFingerprintValue,
      requestFingerprint: job.requestFingerprint,
      cancellationId: portableDestinationUuid(
        bundle.sourceInstallationId,
        "triage_job",
        `${job.id}:cancel`,
        0,
      ),
      ...(job.parentJobId
        ? { parentJobId: remapOf(report, "triage_job", job.parentJobId) }
        : {}),
      request: {
        schemaId: "cd-collab.triage_job_request.v1",
        snapshotId: remapOf(report, "snapshot", job.snapshotId),
        mode: "deterministic_mock",
        strategyId: job.strategyId,
        question: "Imported portable comparison",
        policyFingerprint: null,
        taskFingerprint: job.requestFingerprint,
        candidates: job.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          role: candidate.role,
          provider: candidate.providerKind,
          profileId: candidate.profileId,
          model: candidate.model,
          version: candidate.version,
        })),
      },
      status: job.status,
      candidates: job.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        role: candidate.role,
        provider: candidate.providerKind,
        profileId: candidate.profileId,
        model: candidate.model,
        version: candidate.version,
        status: job.status,
        benchmarkRunId: null,
        outputHash: candidate.outputHash,
        summary: null,
        evidenceRefs: candidate.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
        unknowns: [],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        privacyClass: "owner_only",
      })),
      sameSnapshot: null,
      agreementNotice: "Agreement is not proof of correctness.",
      requestedBy: actor.id,
      requestedByUsername: actor.username,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      stoppedReason: null,
    };
    await ports.jobs.insert(row);
  }

  for (const experiment of bundle.experiments) {
    const id = remapOf(report, "experiment", experiment.id);
    const experimentRow: ExperimentRow = {
      id,
      caseId: investigationId,
      packageId: experiment.packageId,
      sourceSchemaId: "cd-collab.experiment_package.v1",
      taskFingerprint: experiment.taskFingerprint,
      snapshotFingerprint:
        destSnapshotFingerprints.get(
          bundle.snapshots.find((snap) => snap.fingerprint === experiment.snapshotFingerprint)?.id ??
            "",
        ) ?? experiment.snapshotFingerprint,
      snapshotProof: {
        basis: "unknown",
        fairnessClass: "unknown",
        lineageClass: "unknown",
      },
      candidates: experiment.candidateIds.map((candidateId) => ({
        candidateId,
        modelLabel: "imported-historical",
        role: "reviewer",
        runStatus: "completed",
        observedLatency: { status: "unknown" },
        cost: { status: "unknown" },
        usage: { status: "unknown" },
        helpfulnessState: "unreviewed",
        goldState: "unknown",
      })),
      agreement: { sharedAnchors: [], candidateSpecific: [], roleConflicts: [], notes: [] },
      createdAt: experiment.createdAt,
      importerId: actor.id,
      importerUsername: actor.username,
    };
    await ports.experiments.insert(experimentRow);
  }

  for (const observation of bundle.helpfulnessObservations) {
    const reviewer = actorAttribution(observation.reviewerId, identityMap, report, archive);
    const row: HelpfulnessObservationV1 = {
      schemaId: "cd-collab.helpfulness_observation.v1",
      id: remapOf(report, "helpfulness", observation.id),
      experimentId: remapOf(report, "experiment", observation.experimentId),
      candidateId: observation.candidateId,
      dimension: observation.dimension,
      score: observation.score,
      rationale: observation.rationale,
      evidenceRefs: observation.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
      reviewerId: reviewer.id,
      reviewerUsername: reviewer.username,
      createdAt: observation.createdAt,
    };
    await ports.experiments.insertObservation(row);
  }

  for (const decision of bundle.decisions) {
    const author = actorAttribution(decision.authorId, identityMap, report, archive);
    const owner = decision.ownerId
      ? actorAttribution(decision.ownerId, identityMap, report, archive)
      : null;
    const experiment = bundle.experiments.find((row) => row.id === decision.experimentId);
    const row: NormalizedExperimentDecisionV1 = {
      schemaId: "cd-collab.experiment_decision.v1",
      id: remapOf(report, "decision", decision.id),
      experimentId: remapOf(report, "experiment", decision.experimentId),
      status: decision.status,
      revision: decision.revision,
      predecessorRevision: decision.predecessorRevision,
      text: decision.text,
      rationale: decision.rationale,
      evidenceRefs: decision.evidenceRefs.map((id) => remapOf(report, "evidence", id)),
      packageId: experiment?.packageId ?? "pkg-imported",
      authorId: author.id,
      authorUsername: author.username,
      createdAt: decision.createdAt,
      ownerId: owner?.id ?? null,
      ownerUsername: owner?.username ?? null,
      remainingUnknowns: [...(decision.remainingUnknowns ?? [])],
    };
    await ports.experiments.insertDecision(row);
  }

  for (const gold of bundle.gold) {
    const promoter = actorAttribution(gold.promotedById, identityMap, report, archive);
    const experiment = bundle.experiments.find((row) => row.id === gold.experimentId);
    const row: GoldReferenceV1 = {
      schemaId: "cd-collab.gold_reference.v1",
      goldId: remapOf(report, "gold", gold.goldId),
      version: gold.version,
      predecessorGoldId: gold.predecessorGoldId
        ? remapOf(report, "gold", gold.predecessorGoldId)
        : null,
      caseId: investigationId,
      experimentId: remapOf(report, "experiment", gold.experimentId),
      packageId: experiment?.packageId ?? "pkg-imported",
      taskFingerprint: experiment?.taskFingerprint ?? "00".repeat(32),
      snapshotFingerprint:
        destSnapshotFingerprints.get(
          bundle.snapshots.find((snap) => snap.fingerprint === experiment?.snapshotFingerprint)?.id ??
            "",
        ) ??
        experiment?.snapshotFingerprint ??
        "00".repeat(32),
      acceptedDecisionId: remapOf(report, "decision", gold.acceptedDecisionId),
      acceptedDecisionRevision: gold.acceptedDecisionRevision,
      auditRefs: [],
      evidenceAnchors: gold.evidenceAnchors.map((id) => remapOf(report, "evidence", id)),
      notes: gold.notes,
      promotedById: promoter.id,
      promotedByUsername: promoter.username,
      createdAt: gold.createdAt,
    };
    await ports.experiments.insertGold(row);
  }

  for (const event of bundle.timeline) {
    const historical = actorAttribution(event.actorId, identityMap, report, archive);
    await ports.cases.appendTimeline(investigationId, {
      kind: event.kind,
      actor: historical,
      targetId:
        event.targetId &&
        event.targetNamespace &&
        (PORTABLE_OBJECT_KINDS as readonly string[]).includes(event.targetNamespace)
          ? remapOf(report, event.targetNamespace as PortableObjectKind, event.targetId)
          : event.targetId,
      clientTime: null,
      payload: {
        imported: true,
        sourceSeq: event.seq,
        sourceInstallationId: bundle.sourceInstallationId,
      },
    });
  }

  await ports.audit.append({
    identity: actor.id,
    action: "portable_archive_apply",
    target: investigationId,
    origin: input.origin ?? "apply",
    outcome: "success",
  });

  return investigationId;
}
