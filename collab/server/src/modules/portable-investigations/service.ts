import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
  PORTABLE_APPLY_TYPED_CONFIRMATION,
  PORTABLE_HISTORY_CAVEAT,
  PORTABLE_OBJECT_KINDS,
  PORTABLE_PERMISSION_CAVEAT,
  PORTABLE_PROTOCOL_VERSION,
  PORTABLE_SCHEMA_ID,
  attachPortableIntegrity,
  canonicalJson,
  destinationCatalogDigest,
  identityMapDigest,
  parsePortableArchive,
  portableApplyDeepLink,
  portableSnapshotFingerprint,
  preflightPortableArchive,
  sealPortableArchive,
  sha256Text,
  type ArchiveBlobInventoryEntryV1,
  type ArchivePreflightReportV1,
  type CollisionPolicy,
  type DestinationCatalogV1,
  type IdentityMapEntryV1,
  type PortableApplyResponseV1,
  type PortableArchiveV1,
  type PortableContentObjectV1,
  type PortableInvestigationUnsigned,
  type PortableObjectKind,
  type PrivacyClass,
  type ProviderKind,
} from "@cd-collab/contracts";
import { persistPortableArchive, type PortablePersistPorts } from "./persist.js";
import type { AuditStore, StoredAudit } from "../audit/index.js";
import type { CatalogService } from "../catalog/index.js";
import type { Actor, CaseService, TimelineRow } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { ImportService } from "../import/index.js";
import type { TriageRunService } from "../triage-runs/index.js";

export const MAX_PORTABLE_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_PORTABLE_OBJECTS = 25_000;
export const PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE = PORTABLE_APPLY_TYPED_CONFIRMATION;
const APPLY_TOKEN_TTL_MS = 10 * 60 * 1000;

export const PORTABLE_CONTRACT_UNSUPPORTED = [
  "hypothesis_links",
  "file_reference_location_and_verification",
  "triage_candidate_summaries_and_runtime_details",
  "experiment_agreement_and_interaction_traces",
  "imported_content_privacy_is_not_contract_bound",
  "discussion_presence_and_live_chat_state",
  "audit_origins_and_raw_payloads",
] as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

export type PortableServerErrorCode =
  | "not_found"
  | "archive_size_limit"
  | "unsupported_state"
  | "integrity_failure"
  | "archive_invalid"
  | "apply_refused"
  | "confirmation_invalid"
  | "exact_reconstruction_required"
  | "stale_destination_catalog"
  | "identity_map_mismatch"
  | "actor_mismatch";

export class PortableServerError extends Error {
  constructor(
    readonly code: PortableServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortableServerError";
  }
}

export interface PortablePreflightInput {
  mode: "dry_run";
  collisionPolicy: CollisionPolicy;
  identityMap: IdentityMapEntryV1[];
  suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
}

export interface PortablePrivacySummary {
  classification: "share_safe_only" | "contains_owner_only" | "unclassified_content_present";
  ownerOnlyEvidence: number;
  shareSafeEvidence: number;
  unclassifiedContentObjects: number;
  inlineBlobCount: number;
  inlineByteLength: number;
  omittedBlobCount: number;
  privateBlobCount: number;
  redactedBlobCount: number;
}

export interface PortablePreflightResponse {
  schemaId: "cd-collab.portable_investigation_preflight_response.v1";
  report: ArchivePreflightReportV1;
  privacy: PortablePrivacySummary;
  omitted: ArchivePreflightReportV1["reconstructionReasons"];
  unsupported: readonly string[];
  authorization: {
    requiredRole: "case-lead_or_admin";
    evaluatedRole: "case-lead" | "admin";
    actorId: string;
    destinationCatalogSource: "host_visible_catalog";
    destinationCatalogDigest: string;
    sourceRolesTrusted: false;
    destinationMembershipGranted: false;
    destinationRoleGranted: false;
    destinationCapabilityGranted: false;
  };
  apply: {
    available: true;
    requiresExactReconstruction: true;
    typedConfirmation: typeof PORTABLE_APPLY_TYPED_CONFIRMATION;
    confirmationToken: string | null;
    expiresAt: string | null;
    reason: string | null;
  };
}

export interface PortableCapabilities {
  schemaId: "cd-collab.portable_investigation_capabilities.v1";
  exportAvailable: true;
  dryRunPreflightAvailable: true;
  maximumArchiveBytes: number;
  apply: {
    available: true;
    requiresExactReconstruction: true;
    typedConfirmation: typeof PORTABLE_APPLY_TYPED_CONFIRMATION;
  };
}

interface ApplyIntent {
  token: string;
  actorId: string;
  installationId: string;
  transportHash: string;
  semanticFingerprint: string;
  destinationCatalogDigest: string;
  identityMapDigest: string;
  collisionPolicy: CollisionPolicy;
  expiresAt: number;
  appliedInvestigationId: string | null;
}

const APPLY_IDENTITY_ACTIONS = new Set(["map_existing", "preserve_historical_external"]);

interface PortableDeps {
  installationId: string;
  cases: CaseService;
  catalog: CatalogService;
  imports: ImportService;
  triageRuns: TriageRunService;
  experiments: ExperimentService;
  audit: AuditStore;
  persist?: PortablePersistPorts;
  snapshot?: () => unknown | Promise<unknown>;
  restore?: (snapshot: unknown) => void | Promise<void>;
  withTransaction?: <T>(operation: (ports: PortablePersistPorts) => Promise<T>) => Promise<T>;
  now?: () => string;
}

interface ActorSeed {
  id: string;
  username?: string | null;
}

interface ProjectedContent {
  digest: string;
  byteLength: number;
  contentType: string | null;
  inclusion: "present" | "omitted";
  payloadBase64: string | null;
}

function providerKind(value: string | null): ProviderKind {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[_ ]/g, "-");
  if (normalized.includes("ollama")) return "ollama";
  if (normalized.includes("grok") || normalized.includes("xai")) return "xai_grok_build";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (
    normalized.includes("openai") ||
    normalized.includes("gateway") ||
    normalized.includes("compatible")
  ) {
    return "openai_compatible";
  }
  return "unknown";
}

function safeActorLabel(actorId: string): string {
  return `historical-${sha256Text(actorId).slice(0, 12)}`;
}

function addActor(actors: Map<string, string>, seed: ActorSeed): void {
  if (!seed.id) return;
  const username = seed.username?.trim();
  const existing = actors.get(seed.id);
  if (!existing || existing.startsWith("historical-")) {
    actors.set(seed.id, username || safeActorLabel(seed.id));
  }
}

function addObjectId(
  catalog: Partial<Record<PortableObjectKind, Set<string>>>,
  kind: PortableObjectKind,
  id: string,
): void {
  const set = catalog[kind] ?? new Set<string>();
  set.add(id);
  catalog[kind] = set;
}

function portableDiscussionId(caseId: string): string {
  return `discussion-${sha256Text(caseId).slice(0, 24)}`;
}

function ensureSha256(value: string, label: string): void {
  if (!SHA256_RE.test(value)) {
    throw new PortableServerError("unsupported_state", `${label} has no portable SHA-256 identity`);
  }
}

function portableFingerprint(value: string, prefix: "task" | "snap"): string {
  const normalized = value.trim().toLowerCase();
  const digest = normalized.startsWith(`${prefix}-`)
    ? normalized.slice(prefix.length + 1)
    : normalized;
  ensureSha256(digest, `${prefix} fingerprint`);
  return digest;
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectCount(bundle: PortableInvestigationUnsigned): number {
  return (
    1 +
    bundle.actors.length +
    bundle.contributions.length +
    bundle.evidence.length +
    bundle.contentObjects.length +
    bundle.sources.length +
    bundle.importedAiRuns.length +
    bundle.snapshots.length +
    bundle.triageJobs.length +
    bundle.experiments.length +
    bundle.helpfulnessObservations.length +
    bundle.decisions.length +
    bundle.gold.length +
    bundle.alignments.length +
    bundle.discussions.length +
    bundle.timeline.length +
    bundle.auditRefs.length +
    bundle.attachments.length
  );
}

function targetNamespace(
  row: TimelineRow,
  namespaces: Map<string, Set<PortableObjectKind>>,
): PortableObjectKind | null {
  if (row.targetId === null) return null;
  const byKind: Array<[RegExp, PortableObjectKind]> = [
    [/^case_|^legal_hold$/, "investigation"],
    [/^contribution_|^hypothesis_/, "contribution"],
    [/^evidence_/, "evidence"],
    [/^external_run_|^run_corroboration$/, "imported_ai_run"],
    [/^snapshot_/, "snapshot"],
    [/^triage_/, "triage_job"],
    [/^experiment_/, "experiment"],
  ];
  const available = namespaces.get(row.targetId);
  if (!available?.size) return null;
  for (const [pattern, kind] of byKind) {
    if (pattern.test(row.kind) && available.has(kind)) return kind;
  }
  return available.size === 1 ? [...available][0] ?? null : null;
}

function auditMatches(audit: StoredAudit, ids: Set<string>): boolean {
  if (audit.target === null) return false;
  for (const id of ids) {
    if (audit.target === id || audit.target.startsWith(`${id}:`)) return true;
  }
  return false;
}

function privacySummary(archive: PortableArchiveV1): PortablePrivacySummary {
  const ownerOnlyEvidence = archive.investigation.evidence.filter(
    (row) => row.privacyClass === "owner_only",
  ).length;
  const inline = archive.blobInventory.filter((row) => row.presence === "inline");
  const evidenceDigests = new Set(archive.investigation.evidence.map((row) => row.digest));
  const unclassifiedContentObjects = archive.investigation.contentObjects.filter(
    (row) => !evidenceDigests.has(row.digest),
  ).length;
  return {
    classification:
      ownerOnlyEvidence > 0
        ? "contains_owner_only"
        : unclassifiedContentObjects > 0
          ? "unclassified_content_present"
          : "share_safe_only",
    ownerOnlyEvidence,
    shareSafeEvidence: archive.investigation.evidence.length - ownerOnlyEvidence,
    unclassifiedContentObjects,
    inlineBlobCount: inline.length,
    inlineByteLength: inline.reduce((total, row) => total + row.byteLength, 0),
    omittedBlobCount: archive.blobInventory.filter((row) => row.presence === "omitted").length,
    privateBlobCount: archive.blobInventory.filter((row) => row.presence === "private").length,
    redactedBlobCount: archive.blobInventory.filter((row) => row.presence === "redacted").length,
  };
}

export class PortableInvestigationService {
  private readonly now: () => string;
  private readonly intents = new Map<string, ApplyIntent>();
  private applyQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PortableDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  capabilities(): PortableCapabilities {
    return {
      schemaId: "cd-collab.portable_investigation_capabilities.v1",
      exportAvailable: true,
      dryRunPreflightAvailable: true,
      maximumArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES,
      apply: {
        available: true,
        requiresExactReconstruction: true,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
      },
    };
  }

  async exportArchive(caseId: string, actor: Actor, isAdmin: boolean): Promise<PortableArchiveV1> {
    const caseRow = await this.deps.cases.getCase(caseId, actor, isAdmin);
    if (!caseRow) throw new PortableServerError("not_found", "investigation not found");

    const [latestContributions, artifacts, snapshots, timeline, importedRuns, jobs, experiments] =
      await Promise.all([
        this.deps.cases.listContributions(caseId, actor, isAdmin),
        this.deps.cases.listArtifacts(caseId, actor, isAdmin),
        this.deps.cases.listSnapshots(caseId, actor, isAdmin),
        this.deps.cases.listTimeline(caseId),
        this.deps.imports.listRuns(caseId, actor, isAdmin),
        this.deps.triageRuns.list(caseId, actor, isAdmin),
        this.deps.experiments.list(caseId, actor, isAdmin),
      ]);
    const contributionChains = await Promise.all(
      latestContributions.map((row) => this.deps.cases.provenance(caseId, row.id)),
    );
    const contributions = contributionChains.flat();
    const sourceIds = new Set<string>([
      ...contributions.map((row) => row.sourceId),
      ...artifacts.map((row) => row.sourceId),
      ...importedRuns.map((row) => row.sourceId),
    ]);
    const allSources = await this.deps.catalog.list();
    const sources = allSources.filter((row) => sourceIds.has(row.id));
    if (sources.length !== sourceIds.size) {
      throw new PortableServerError("integrity_failure", "investigation has a dangling source");
    }

    const actors = new Map<string, string>();
    addActor(actors, { id: caseRow.createdBy });
    for (const participant of caseRow.participants) {
      addActor(actors, { id: participant.identityId, username: participant.username });
    }
    for (const row of contributions) {
      addActor(actors, { id: row.authorId, username: row.authorUsername });
    }
    for (const row of artifacts) addActor(actors, { id: row.uploaderId });
    for (const row of snapshots) addActor(actors, { id: row.createdBy });
    for (const row of importedRuns) {
      addActor(actors, { id: row.importerId, username: row.importerUsername });
      addActor(actors, { id: row.operatorId, username: row.operatorUsername });
    }
    for (const row of jobs) addActor(actors, { id: row.requestedBy, username: row.requestedByUsername });
    for (const row of experiments) {
      for (const observation of row.observations) {
        addActor(actors, { id: observation.reviewerId, username: observation.reviewerUsername });
      }
      for (const decision of row.decisions) {
        addActor(actors, { id: decision.authorId, username: decision.authorUsername });
        if (decision.ownerId) addActor(actors, { id: decision.ownerId, username: decision.ownerUsername });
      }
      for (const gold of row.golds) {
        addActor(actors, { id: gold.promotedById, username: gold.promotedByUsername });
      }
    }
    for (const row of timeline) addActor(actors, { id: row.actorId, username: row.actorUsername });
    for (const row of sources) {
      addActor(actors, { id: row.createdBy });
      if (row.identityId) addActor(actors, { id: row.identityId, username: row.name });
    }

    const contents = new Map<string, ProjectedContent>();
    const addContent = (
      digest: string,
      bytes: Uint8Array | null,
      contentType: string | null,
      byteLength: number,
    ): void => {
      ensureSha256(digest, "content");
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new PortableServerError("unsupported_state", "content byte length is unknown");
      }
      if (bytes && (bytes.byteLength !== byteLength || bytesDigest(bytes) !== digest)) {
        throw new PortableServerError("integrity_failure", "stored content failed hash or length verification");
      }
      const prior = contents.get(digest);
      const next: ProjectedContent = {
        digest,
        byteLength,
        contentType,
        inclusion: bytes ? "present" : "omitted",
        payloadBase64: bytes ? Buffer.from(bytes).toString("base64") : null,
      };
      if (!prior) {
        contents.set(digest, next);
        return;
      }
      if (prior.byteLength !== next.byteLength) {
        throw new PortableServerError("integrity_failure", "duplicate content digest has conflicting length");
      }
      if (prior.contentType !== next.contentType) prior.contentType = null;
      if (prior.inclusion === "omitted" && next.inclusion === "present") {
        prior.inclusion = "present";
        prior.payloadBase64 = next.payloadBase64;
      }
    };

    const registeredAt = new Map(
      timeline
        .filter((row) => row.kind === "evidence_registered" && row.targetId !== null)
        .map((row) => [row.targetId as string, row.serverTime]),
    );
    for (const artifact of artifacts) {
      const digest = artifact.contentHash ?? artifact.expectedHash;
      if (!digest) {
        throw new PortableServerError(
          "unsupported_state",
          "unhashed evidence cannot be represented by the portable contract",
        );
      }
      const bytes = artifact.contentHash
        ? await this.deps.cases.getArtifactBytes(caseId, artifact.id, actor, isAdmin)
        : null;
      if (artifact.contentHash && !bytes) {
        throw new PortableServerError("integrity_failure", "held evidence bytes are missing");
      }
      const byteLength = artifact.byteLength ?? bytes?.byteLength;
      if (byteLength === undefined) {
        throw new PortableServerError(
          "unsupported_state",
          "evidence with unknown byte length cannot be represented",
        );
      }
      addContent(digest, bytes, artifact.mediaType, byteLength);
      if (!registeredAt.has(artifact.id)) {
        throw new PortableServerError("integrity_failure", "evidence registration time is missing");
      }
    }

    for (const run of importedRuns) {
      const output = new TextEncoder().encode(run.outputText);
      addContent(run.outputHash, output, "text/plain", output.byteLength);
      if (run.promptHash !== null && run.promptText !== null) {
        const prompt = new TextEncoder().encode(run.promptText);
        addContent(run.promptHash, prompt, "text/plain", prompt.byteLength);
      } else if (run.promptHash !== null || run.promptText !== null) {
        throw new PortableServerError("integrity_failure", "imported prompt hash and bytes disagree");
      }
    }

    const contentRows = (): PortableContentObjectV1[] =>
      [...contents.values()].map((row) => ({ ...row, objectHash: "" }));

    const evidence = artifacts.map((artifact) => {
      const digest = artifact.contentHash ?? artifact.expectedHash;
      if (!digest) throw new PortableServerError("unsupported_state", "evidence digest is missing");
      const content = contents.get(digest);
      if (!content) throw new PortableServerError("integrity_failure", "content projection is missing");
      return {
        id: artifact.id,
        title: artifact.filename?.trim() || `${artifact.kind} evidence`,
        privacyClass: artifact.privacyClass,
        digest,
        inclusion: content.inclusion,
        contentType: content.contentType,
        byteLength: content.byteLength,
        createdBy: artifact.uploaderId,
        createdAt: registeredAt.get(artifact.id) as string,
        objectHash: "",
      };
    });

    const snapshotFingerprintMap = new Map<string, string>();
    const portableSnapshots = snapshots.map((snapshot) => {
      const projectedEvidence = snapshot.evidence.map((row) => ({
        evidenceId: row.evidenceId,
        ordinal: row.ordinal,
        contentHash: row.contentHash ?? row.expectedHash,
        privacyClass: row.privacyClass,
      }));
      const base = {
        id: snapshot.id,
        parentSnapshotId: snapshot.parentSnapshotId,
        fairnessClass:
          projectedEvidence.length === 0 || projectedEvidence.every((row) => row.contentHash !== null)
            ? ("same_snapshot" as const)
            : ("unknown" as const),
        lineageClass: snapshot.parentSnapshotId ? ("derived" as const) : ("root" as const),
        visibility: snapshot.visibility,
        protocolVersion: snapshot.protocolVersion,
        evidence: projectedEvidence,
        createdAt: snapshot.createdAt,
        createdBy: snapshot.createdBy,
      };
      const fingerprint = portableSnapshotFingerprint(base);
      snapshotFingerprintMap.set(snapshot.fingerprint, fingerprint);
      snapshotFingerprintMap.set(`snap-${snapshot.fingerprint}`, fingerprint);
      return { ...base, fingerprint, objectHash: "" };
    });

    const portableJobs = jobs.map((job) => {
      const snapshotFingerprint = snapshotFingerprintMap.get(job.snapshotFingerprint);
      if (!snapshotFingerprint) {
        throw new PortableServerError("integrity_failure", "triage job snapshot is not portable");
      }
      return {
        id: job.id,
        snapshotId: job.snapshotId,
        snapshotFingerprint,
        strategyId: job.request.strategyId,
        status: job.status,
        parentJobId: job.parentJobId ?? null,
        requestFingerprint: job.requestFingerprint,
        candidates: job.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          role: candidate.role,
          providerKind: providerKind(candidate.provider),
          profileId: candidate.profileId,
          model: candidate.model,
          version: candidate.version,
          usageStatus: "unknown" as const,
          costStatus: "unknown" as const,
          outputHash: candidate.outputHash,
          evidenceRefs: [...candidate.evidenceRefs],
        })),
        requestedBy: job.requestedBy,
        createdAt: job.createdAt,
        objectHash: "",
      };
    });

    const portableExperiments = experiments.map((experiment) => {
      const snapshotFingerprint = snapshotFingerprintMap.get(experiment.snapshotFingerprint);
      if (!snapshotFingerprint) {
        throw new PortableServerError("integrity_failure", "experiment snapshot is not portable");
      }
      return {
        id: experiment.id,
        packageId: experiment.packageId,
        snapshotFingerprint,
        taskFingerprint: portableFingerprint(experiment.taskFingerprint, "task"),
        candidateIds: experiment.candidates.map((candidate) => candidate.candidateId),
        createdAt: experiment.createdAt,
        objectHash: "",
      };
    });

    const helpfulnessObservations = experiments.flatMap((experiment) =>
      experiment.observations.map((row) => ({
        id: row.id,
        experimentId: experiment.id,
        candidateId: row.candidateId,
        dimension: row.dimension,
        score: row.score,
        rationale: row.rationale,
        evidenceRefs: [...row.evidenceRefs],
        reviewerId: row.reviewerId,
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const decisions = experiments.flatMap((experiment) =>
      experiment.decisions.map((row) => ({
        id: row.id,
        experimentId: experiment.id,
        status: row.status,
        revision: row.revision,
        predecessorRevision: row.predecessorRevision,
        text: row.text,
        rationale: row.rationale,
        evidenceRefs: [...row.evidenceRefs],
        authorId: row.authorId,
        ownerId: row.ownerId,
        remainingUnknowns: [...row.remainingUnknowns],
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const gold = experiments.flatMap((experiment) =>
      experiment.golds.map((row) => ({
        goldId: row.goldId,
        version: row.version,
        predecessorGoldId: row.predecessorGoldId,
        experimentId: experiment.id,
        acceptedDecisionId: row.acceptedDecisionId,
        acceptedDecisionRevision: row.acceptedDecisionRevision,
        evidenceAnchors: [...row.evidenceAnchors],
        notes: [...row.notes],
        promotedById: row.promotedById,
        createdAt: row.createdAt,
        objectHash: "",
      })),
    );
    const alignments = experiments.flatMap((experiment) =>
      experiment.gold
        ? experiment.alignments.map((row) => ({
            id: `alignment-${sha256Text(`${experiment.id}:${experiment.gold?.goldId ?? ""}:${row.candidateId}`).slice(0, 24)}`,
            goldId: experiment.gold?.goldId as string,
            candidateId: row.candidateId,
            status: row.status,
            matchedAnchors: [...row.matchedAnchors],
            missingAnchors: [...row.missingAnchors],
            extraAnchors: [...row.extraAnchors],
            notes: [...row.notes],
            objectHash: "",
          }))
        : [],
    );

    const messageRows = contributions.filter((row) => row.kind === "message");
    const discussionId = messageRows.length ? portableDiscussionId(caseId) : null;
    const discussions = discussionId
      ? [
          {
            id: discussionId,
            title: `${caseRow.title} discussion`,
            authorId: messageRows[0]?.authorId ?? caseRow.createdBy,
            createdAt: messageRows[0]?.createdAt ?? caseRow.createdAt,
            messageIds: [...new Set(messageRows.map((row) => row.id))],
            objectHash: "",
          },
        ]
      : [];

    const attachments = artifacts
      .filter((row) => row.kind === "attachment")
      .map((row) => {
        const digest = row.contentHash ?? row.expectedHash;
        if (!digest) throw new PortableServerError("unsupported_state", "attachment digest is missing");
        const content = contents.get(digest);
        if (!content) throw new PortableServerError("integrity_failure", "attachment content is missing");
        return {
          id: row.id,
          discussionId: null,
          evidenceId: row.id,
          digest,
          inclusion: content.inclusion,
          objectHash: "",
        };
      });

    const namespaceById = new Map<string, Set<PortableObjectKind>>();
    const registerNamespace = (kind: PortableObjectKind, ids: readonly string[]): void => {
      for (const id of ids) {
        const set = namespaceById.get(id) ?? new Set<PortableObjectKind>();
        set.add(kind);
        namespaceById.set(id, set);
      }
    };
    registerNamespace("investigation", [caseId]);
    registerNamespace("contribution", contributions.map((row) => row.id));
    registerNamespace("evidence", evidence.map((row) => row.id));
    registerNamespace("source", sources.map((row) => row.id));
    registerNamespace("imported_ai_run", importedRuns.map((row) => row.id));
    registerNamespace("snapshot", portableSnapshots.map((row) => row.id));
    registerNamespace("triage_job", portableJobs.map((row) => row.id));
    registerNamespace("experiment", portableExperiments.map((row) => row.id));
    registerNamespace("helpfulness", helpfulnessObservations.map((row) => row.id));
    registerNamespace("decision", decisions.map((row) => row.id));
    registerNamespace("gold", gold.map((row) => row.goldId));
    registerNamespace("alignment", alignments.map((row) => row.id));
    registerNamespace("discussion", discussions.map((row) => row.id));
    registerNamespace("attachment", attachments.map((row) => row.id));

    const portableTimeline = timeline.map((row) => {
      const namespace = targetNamespace(row, namespaceById);
      return {
        seq: row.seq,
        kind: row.kind,
        actorId: row.actorId,
        targetId: namespace ? row.targetId : null,
        targetNamespace: namespace,
        serverTime: row.serverTime,
        objectHash: "",
      };
    });

    const knownIds = new Set<string>([caseId, ...namespaceById.keys()]);
    const audits = (await this.deps.audit.list()).filter((row) => auditMatches(row, knownIds));
    for (const audit of audits) addActor(actors, { id: audit.identity ?? "system" });
    const auditRefs = audits.map((row) => ({
      id: `audit-${row.id}`,
      kind: row.action,
      actorId: row.identity ?? "system",
      createdAt: row.at.toISOString(),
      summaryHash: sha256Text(canonicalJson({ action: row.action, target: row.target, outcome: row.outcome })),
      objectHash: "",
    }));

    const privacyClass: PrivacyClass =
      contributions.some((row) => row.privacyClass === "owner_only") ||
      artifacts.some((row) => row.privacyClass === "owner_only")
        ? "owner_only"
        : "share_safe";
    const exportedAt = this.now();
    const unsigned: PortableInvestigationUnsigned = {
      schemaId: PORTABLE_SCHEMA_ID,
      protocolVersion: PORTABLE_PROTOCOL_VERSION,
      sourceInstallationId: this.deps.installationId,
      exportedAt,
      permissionCaveat: PORTABLE_PERMISSION_CAVEAT,
      historyCaveat: PORTABLE_HISTORY_CAVEAT,
      investigation: {
        id: caseRow.id,
        title: caseRow.title,
        status: caseRow.status,
        severity: caseRow.severity,
        legalHold: caseRow.legalHold,
        retentionClass: caseRow.retentionClass,
        privacyClass,
        problemStatement: caseRow.problemStatement ?? "",
        affectedParties: caseRow.affectedParties ?? "",
        impact: caseRow.impact ?? "",
        scope: caseRow.scope ?? "",
        openQuestions: [...(caseRow.openQuestions ?? [])],
        situationVersion: caseRow.situationVersion ?? 0,
        createdAt: caseRow.createdAt,
        createdBy: caseRow.createdBy,
        objectHash: "",
      },
      actors: [...actors.entries()].map(([sourceActorId, username]) => ({
        sourceActorId,
        username,
        displayName: username,
        email: null,
        roleNote: "Historical attribution only",
        objectHash: "",
      })),
      participants: caseRow.participants.map((row) => ({
        sourceActorId: row.identityId,
        role: "member",
      })),
      contributions: contributions.map((row) => ({
        id: row.id,
        kind: row.kind,
        revision: row.revision,
        predecessorRevision: row.predecessorRevision,
        body: row.tombstoned ? null : row.body,
        contentHash: row.body === null ? row.contentHash : sha256Text(row.body),
        privacyClass: row.privacyClass,
        tombstoned: row.tombstoned,
        authorId: row.authorId,
        sourceId: row.sourceId,
        createdAt: row.createdAt,
        hypothesisStatus: row.hypothesisStatus,
        objectHash: "",
      })),
      evidence,
      contentObjects: contentRows(),
      sources: sources.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        lifecycle: row.lifecycle,
        identityId: row.identityId,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        objectHash: "",
      })),
      importedAiRuns: importedRuns.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        importedAt: row.createdAt,
        providerKind: providerKind(row.provider),
        model: row.model ?? "unknown",
        version: row.version,
        profileId: null,
        usageStatus: "unknown",
        costStatus: "unknown",
        outputDigest: row.outputHash,
        opaquePayloadJson: canonicalJson({
          promptDigest: row.promptHash,
          promptCompleteness: row.promptCompleteness,
          outputCompleteness: row.outputCompleteness,
          workflowCompleteness: row.workflowCompleteness,
          evidenceVisibility: row.evidenceVisibility,
          snapshotBinding: row.snapshotBinding,
          corroborationState: row.corroborationState,
          redacted: row.redacted,
        }),
        objectHash: "",
      })),
      snapshots: portableSnapshots,
      triageJobs: portableJobs,
      experiments: portableExperiments,
      helpfulnessObservations,
      decisions,
      gold,
      alignments,
      discussions,
      timeline: portableTimeline,
      auditRefs,
      attachments,
    };
    const [caseCheck, timelineCheck] = await Promise.all([
      this.deps.cases.getCase(caseId, actor, isAdmin),
      this.deps.cases.listTimeline(caseId),
    ]);
    if (
      !caseCheck ||
      canonicalJson(caseCheck) !== canonicalJson(caseRow) ||
      canonicalJson(timelineCheck) !== canonicalJson(timeline)
    ) {
      throw new PortableServerError(
        "integrity_failure",
        "investigation changed while the portable archive was being assembled",
      );
    }
    if (objectCount(unsigned) > MAX_PORTABLE_OBJECTS) {
      throw new PortableServerError("archive_size_limit", "portable object count exceeds limit");
    }
    try {
      const investigation = attachPortableIntegrity(unsigned);
      const archive = sealPortableArchive({ investigation, exportedAt });
      const encodedBytes = Buffer.byteLength(JSON.stringify(archive), "utf8");
      if (encodedBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
        throw new PortableServerError("archive_size_limit", "portable archive exceeds size limit");
      }
      return archive;
    } catch (error) {
      if (error instanceof PortableServerError) throw error;
      throw new PortableServerError("integrity_failure", "portable archive projection failed validation");
    }
  }

  async preflight(
    archiveRaw: unknown,
    input: PortablePreflightInput,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<PortablePreflightResponse> {
    const evaluated = await this.evaluateArchive(archiveRaw, input, actor, isAdmin);
    return {
      ...evaluated.response,
      apply: this.mintApplyOffer(actor, evaluated.archive, evaluated.report, input),
    };
  }

  private async evaluateArchive(
    archiveRaw: unknown,
    input: PortablePreflightInput,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{
    archive: PortableArchiveV1;
    report: ArchivePreflightReportV1;
    response: Omit<PortablePreflightResponse, "apply">;
  }> {
    let encodedBytes: number;
    try {
      encodedBytes = Buffer.byteLength(JSON.stringify(archiveRaw), "utf8");
    } catch {
      throw new PortableServerError("archive_invalid", "portable archive failed validation");
    }
    if (encodedBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
      throw new PortableServerError("archive_size_limit", "portable archive exceeds size limit");
    }
    let archive: PortableArchiveV1;
    try {
      archive = parsePortableArchive(archiveRaw);
    } catch {
      throw new PortableServerError("archive_invalid", "portable archive failed validation");
    }
    if (objectCount(archive.investigation) > MAX_PORTABLE_OBJECTS) {
      throw new PortableServerError("archive_size_limit", "portable object count exceeds limit");
    }
    const catalog = await this.destinationCatalog(actor, isAdmin);
    const catalogDigest = destinationCatalogDigest(catalog);
    let report: ArchivePreflightReportV1;
    try {
      report = preflightPortableArchive(archive, {
        mode: "dry_run",
        collisionPolicy: input.collisionPolicy,
        identityMap: input.identityMap,
        destination: structuredClone(catalog),
        ...(input.suppliedBlobs ? { suppliedBlobs: input.suppliedBlobs } : {}),
      });
    } catch {
      throw new PortableServerError("archive_invalid", "portable preflight failed validation");
    }
    report = { ...report, destinationCatalogDigest: catalogDigest };
    return {
      archive,
      report,
      response: {
        schemaId: "cd-collab.portable_investigation_preflight_response.v1",
        report,
        privacy: privacySummary(archive),
        omitted: report.reconstructionReasons,
        unsupported: PORTABLE_CONTRACT_UNSUPPORTED,
        authorization: {
          requiredRole: "case-lead_or_admin",
          evaluatedRole: isAdmin ? "admin" : "case-lead",
          actorId: actor.id,
          destinationCatalogSource: "host_visible_catalog",
          destinationCatalogDigest: report.destinationCatalogDigest,
          sourceRolesTrusted: false,
          destinationMembershipGranted: false,
          destinationRoleGranted: false,
          destinationCapabilityGranted: false,
        },
      },
    };
  }

  private identityMapAllowsApply(identityMap: IdentityMapEntryV1[]): boolean {
    return identityMap.every((row) => APPLY_IDENTITY_ACTIONS.has(row.action));
  }

  private mintApplyOffer(
    actor: Actor,
    archive: PortableArchiveV1,
    report: ArchivePreflightReportV1,
    input: PortablePreflightInput,
  ): PortablePreflightResponse["apply"] {
    this.pruneIntents();
    if (!report.exactReconstruction || !this.identityMapAllowsApply(input.identityMap)) {
      return {
        available: true,
        requiresExactReconstruction: true,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
        confirmationToken: null,
        expiresAt: null,
        reason: "exact_reconstruction_required",
      };
    }
    const token = `pit1.${randomBytes(24).toString("base64url")}`;
    const expiresAt = Date.parse(this.now()) + APPLY_TOKEN_TTL_MS;
    this.intents.set(token, {
      token,
      actorId: actor.id,
      installationId: this.deps.installationId,
      transportHash: archive.transportHash,
      semanticFingerprint: archive.semanticFingerprint,
      destinationCatalogDigest: report.destinationCatalogDigest,
      identityMapDigest: identityMapDigest(input.identityMap),
      collisionPolicy: input.collisionPolicy,
      expiresAt,
      appliedInvestigationId: null,
    });
    return {
      available: true,
      requiresExactReconstruction: true,
      typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
      confirmationToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      reason: null,
    };
  }

  private pruneIntents(): void {
    const now = Date.parse(this.now());
    for (const [token, intent] of this.intents) {
      if (intent.expiresAt < now && !intent.appliedInvestigationId) this.intents.delete(token);
    }
  }

  async apply(
    archiveRaw: unknown,
    input: {
      confirmationToken: string;
      typedConfirmation: string;
      collisionPolicy: CollisionPolicy;
      identityMap: IdentityMapEntryV1[];
      suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
    },
    actor: Actor,
    isAdmin: boolean,
  ): Promise<PortableApplyResponseV1> {
    const run = this.applyQueue.then(() => this.applyExclusive(archiveRaw, input, actor, isAdmin));
    this.applyQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyExclusive(
    archiveRaw: unknown,
    input: {
      confirmationToken: string;
      typedConfirmation: string;
      collisionPolicy: CollisionPolicy;
      identityMap: IdentityMapEntryV1[];
      suppliedBlobs?: ArchiveBlobInventoryEntryV1[];
    },
    actor: Actor,
    isAdmin: boolean,
  ): Promise<PortableApplyResponseV1> {
    if (input.typedConfirmation !== PORTABLE_APPLY_TYPED_CONFIRMATION) {
      throw new PortableServerError("confirmation_invalid", "typed confirmation is required");
    }
    const identityMap = input.identityMap.map((row) => ({ ...row }));
    const collisionPolicy = input.collisionPolicy;
    const suppliedBlobs = input.suppliedBlobs?.map((row) => ({ ...row }));
    const intent = this.intents.get(input.confirmationToken);
    if (!intent) {
      throw new PortableServerError("confirmation_invalid", "confirmation token is unknown");
    }
    if (Date.parse(this.now()) > intent.expiresAt) {
      throw new PortableServerError("confirmation_invalid", "confirmation token expired");
    }
    if (intent.actorId !== actor.id) {
      throw new PortableServerError("actor_mismatch", "confirmation belongs to a different actor");
    }
    if (intent.installationId !== this.deps.installationId) {
      throw new PortableServerError("apply_refused", "installation mismatch");
    }
    if (intent.collisionPolicy !== collisionPolicy) {
      throw new PortableServerError("confirmation_invalid", "collision policy does not match intent");
    }
    if (identityMapDigest(identityMap) !== intent.identityMapDigest) {
      throw new PortableServerError("identity_map_mismatch", "identity map does not match intent");
    }
    if (!this.identityMapAllowsApply(identityMap)) {
      throw new PortableServerError("exact_reconstruction_required", "unresolved identities cannot be applied");
    }
    if (intent.appliedInvestigationId) {
      let archive: PortableArchiveV1;
      try {
        archive = parsePortableArchive(archiveRaw);
      } catch {
        throw new PortableServerError("archive_invalid", "portable archive failed validation");
      }
      if (archive.transportHash !== intent.transportHash) {
        throw new PortableServerError("archive_invalid", "transport hash does not match intent");
      }
      return {
        schemaId: PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
        status: "idempotent_replay",
        investigationId: intent.appliedInvestigationId,
        deepLink: portableApplyDeepLink(intent.appliedInvestigationId),
        transportHash: intent.transportHash,
        semanticFingerprint: intent.semanticFingerprint,
        destinationCatalogDigest: intent.destinationCatalogDigest,
        authenticityClaim: "none",
        destinationMembershipGranted: false,
        destinationRoleGranted: false,
        destinationCapabilityGranted: false,
      };
    }
    const preview = await this.evaluateArchive(
      archiveRaw,
      {
        mode: "dry_run",
        collisionPolicy,
        identityMap,
        ...(suppliedBlobs ? { suppliedBlobs } : {}),
      },
      actor,
      isAdmin,
    );
    if (preview.report.transportHash !== intent.transportHash) {
      throw new PortableServerError("archive_invalid", "transport hash does not match intent");
    }
    if (preview.report.semanticFingerprint !== intent.semanticFingerprint) {
      throw new PortableServerError("archive_invalid", "semantic fingerprint does not match intent");
    }
    if (preview.report.destinationCatalogDigest !== intent.destinationCatalogDigest) {
      throw new PortableServerError("stale_destination_catalog", "destination catalog changed");
    }
    if (!preview.report.exactReconstruction) {
      throw new PortableServerError("exact_reconstruction_required", "apply requires exact reconstruction");
    }
    const replay = this.appliedResponse(intent, preview.report, "idempotent_replay");
    if (replay) return replay;
    const existingId = await this.findAppliedByTransportHash(preview.report.transportHash);
    if (existingId) {
      intent.appliedInvestigationId = existingId;
      return this.appliedResponse(intent, preview.report, "idempotent_replay") as PortableApplyResponseV1;
    }
    if (!this.deps.persist && !this.deps.withTransaction) {
      throw new PortableServerError("apply_refused", "persist ports are not configured");
    }
    const snapshot = this.deps.snapshot ? await this.deps.snapshot() : undefined;
    try {
      const persistOp = (ports: PortablePersistPorts) =>
        persistPortableArchive({
          archive: preview.archive,
          report: preview.report,
          identityMap,
          actor,
          ports,
          now: this.now(),
        });
      const investigationId = this.deps.withTransaction
        ? await this.deps.withTransaction(persistOp)
        : await persistOp(this.deps.persist as PortablePersistPorts);
      const existing = await this.deps.cases.getCase(investigationId, actor, isAdmin);
      if (!existing) {
        throw new PortableServerError("integrity_failure", "imported investigation is not visible");
      }
      if (existing.participants.some((row) => row.identityId !== actor.id)) {
        throw new PortableServerError("apply_refused", "historical people must not become members");
      }
      intent.appliedInvestigationId = investigationId;
      return this.appliedResponse(intent, preview.report, "applied") as PortableApplyResponseV1;
    } catch (error) {
      if (snapshot !== undefined) await this.deps.restore?.(snapshot);
      if (error instanceof PortableServerError) throw error;
      throw new PortableServerError("apply_refused", "atomic apply rolled back");
    }
  }

  private appliedResponse(
    intent: ApplyIntent,
    report: ArchivePreflightReportV1,
    status: PortableApplyResponseV1["status"],
  ): PortableApplyResponseV1 | null {
    if (!intent.appliedInvestigationId) return null;
    return {
      schemaId: PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
      status,
      investigationId: intent.appliedInvestigationId,
      deepLink: portableApplyDeepLink(intent.appliedInvestigationId),
      transportHash: report.transportHash,
      semanticFingerprint: report.semanticFingerprint,
      destinationCatalogDigest: report.destinationCatalogDigest,
      authenticityClaim: "none",
      destinationMembershipGranted: false,
      destinationRoleGranted: false,
      destinationCapabilityGranted: false,
    };
  }

  private async findAppliedByTransportHash(transportHash: string): Promise<string | null> {
    if (!this.deps.persist) return null;
    const cases = await this.deps.persist.cases.listCases();
    for (const row of cases) {
      const timeline = await this.deps.persist.cases.listTimeline(row.id);
      for (const event of timeline) {
        if (event.kind !== "portable_archive_applied") continue;
        try {
          const payload = JSON.parse(event.payload) as { transportHash?: unknown };
          if (payload.transportHash === transportHash) return row.id;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private async destinationCatalog(actor: Actor, isAdmin: boolean): Promise<DestinationCatalogV1> {
    const cases = await this.deps.cases.listCases(actor, isAdmin);
    const identities = new Map<string, { actorId: string; username: string; email: null; displayName: string }>();
    identities.set(actor.id, {
      actorId: actor.id,
      username: actor.username,
      email: null,
      displayName: actor.username,
    });
    const ids: Partial<Record<PortableObjectKind, Set<string>>> = {};
    const sources = await this.deps.catalog.list();
    for (const source of sources) addObjectId(ids, "source", source.id);
    for (const caseRow of cases) {
      addObjectId(ids, "investigation", caseRow.id);
      for (const participant of caseRow.participants) {
        identities.set(participant.identityId, {
          actorId: participant.identityId,
          username: participant.username,
          email: null,
          displayName: participant.username,
        });
        addObjectId(ids, "actor", participant.identityId);
      }
      const [contributions, artifacts, snapshots, runs, jobs, experiments, timeline] = await Promise.all([
        this.deps.cases.listContributions(caseRow.id, actor, isAdmin),
        this.deps.cases.listArtifacts(caseRow.id, actor, isAdmin),
        this.deps.cases.listSnapshots(caseRow.id, actor, isAdmin),
        this.deps.imports.listRuns(caseRow.id, actor, isAdmin),
        this.deps.triageRuns.list(caseRow.id, actor, isAdmin),
        this.deps.experiments.list(caseRow.id, actor, isAdmin),
        this.deps.cases.listTimeline(caseRow.id),
      ]);
      for (const row of contributions) addObjectId(ids, "contribution", row.id);
      for (const row of artifacts) {
        addObjectId(ids, "evidence", row.id);
        if (row.contentHash) addObjectId(ids, "content", row.contentHash);
        if (row.kind === "attachment") addObjectId(ids, "attachment", row.id);
      }
      for (const row of snapshots) addObjectId(ids, "snapshot", row.id);
      for (const row of runs) addObjectId(ids, "imported_ai_run", row.id);
      for (const row of jobs) addObjectId(ids, "triage_job", row.id);
      for (const row of experiments) {
        addObjectId(ids, "experiment", row.id);
        for (const observation of row.observations) addObjectId(ids, "helpfulness", observation.id);
        for (const decision of row.decisions) addObjectId(ids, "decision", decision.id);
        for (const gold of row.golds) addObjectId(ids, "gold", gold.goldId);
        if (row.gold) {
          for (const alignment of row.alignments) {
            addObjectId(
              ids,
              "alignment",
              `alignment-${sha256Text(`${row.id}:${row.gold.goldId}:${alignment.candidateId}`).slice(0, 24)}`,
            );
          }
        }
      }
      if (contributions.some((row) => row.kind === "message")) {
        addObjectId(ids, "discussion", portableDiscussionId(caseRow.id));
      }
      for (const row of timeline) addObjectId(ids, "timeline", String(row.seq));
    }
    addObjectId(ids, "actor", actor.id);
    const objectIds: DestinationCatalogV1["objectIds"] = {};
    for (const kind of PORTABLE_OBJECT_KINDS) {
      const values = ids[kind];
      if (values) objectIds[kind] = [...values];
    }
    return {
      identities: [...identities.values()],
      objectIds,
      knownProfileIds: this.deps.triageRuns.listProfiles().map((row) => row.id),
    };
  }
}
